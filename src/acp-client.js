import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ACPError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ACPError';
    this.details = details;
  }
}

export class KiroACPClient extends EventEmitter {
  constructor({ cliPath = process.env.KIRO_CLI_PATH || 'kiro-cli', cwd = process.cwd(), env = process.env } = {}) {
    super();
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.sessions = new Map();
  }

  async start() {
    if (this.proc) return;

    this.proc = spawn(this.cliPath, ['acp'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk));
    this.proc.on('exit', (code, signal) => {
      const err = new ACPError(`kiro-cli exited`, { code, signal });
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
      this.proc = null;
      this.emit('exit', { code, signal });
    });

    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kiro-openai-proxy', version: '1.0.0' },
    }, { timeoutMs: 30_000 });
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.stdin.end();
    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) proc.kill('SIGTERM');
    }, 1000).unref();
  }

  async newSession({ cwd = this.cwd } = {}) {
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    const sessionId = result.sessionId || result.session_id || randomUUID();
    this.sessions.set(sessionId, { updates: [], metadata: {} });
    return sessionId;
  }

  async loadSession(sessionId, { cwd = this.cwd } = {}) {
    const result = await this.request('session/load', { sessionId, cwd, mcpServers: [] });
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { updates: [], metadata: {} });
    return result;
  }

  async prompt(sessionId, text, { timeoutMs = DEFAULT_TIMEOUT_MS, model } = {}) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { updates: [], metadata: {} });
    const state = this.sessions.get(sessionId);
    state.updates = [];

    const params = {
      sessionId,
      prompt: [{ type: 'text', text }],
    };
    if (model) params.model = model;

    const result = await this.request('session/prompt', params, { timeoutMs });

    return this.#buildPromptResult(sessionId, result);
  }

  request(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.proc?.stdin.writable) throw new ACPError('kiro-cli ACP process is not running');
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ACPError(`ACP request timed out: ${method}`, { id, timeoutMs }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.#handleLine(line);
    }
  }

  #handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('log', line);
      return;
    }

    if (msg.id != null && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new ACPError(msg.error.message || 'ACP error', msg.error));
      else pending.resolve(msg.result ?? {});
      return;
    }

    if (msg.id != null && msg.method === 'session/request_permission') {
      this.#allowPermission(msg.id, msg.params || {});
      return;
    }

    if (msg.method) {
      const params = msg.params || {};
      const sessionId = params.sessionId;
      if (sessionId && !this.sessions.has(sessionId)) this.sessions.set(sessionId, { updates: [], metadata: {} });
      if (msg.method === 'session/update' && sessionId) {
        this.sessions.get(sessionId).updates.push(params.update || params);
      } else if (msg.method === '_kiro.dev/metadata' && sessionId) {
        Object.assign(this.sessions.get(sessionId).metadata, params);
      }
      this.emit('notification', msg);
    }
  }

  #allowPermission(id, params) {
    const options = params.options || [];
    const optionId = options.find((o) => /allow.*once|yes|approve/i.test(`${o.optionId} ${o.name}`))?.optionId
      || options[0]?.optionId
      || 'allow_once';
    const response = { jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } };
    this.proc?.stdin.write(`${JSON.stringify(response)}\n`);
  }

  #buildPromptResult(sessionId, rpcResult) {
    const state = this.sessions.get(sessionId) || { updates: [], metadata: {} };
    const text = [];
    const toolCalls = [];

    for (const update of state.updates) {
      const kind = update.sessionUpdate || update.type || update.kind;
      const content = update.content;
      if (kind === 'agent_message_chunk') {
        if (typeof content === 'string') text.push(content);
        else if (content?.type === 'text') text.push(content.text || '');
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        toolCalls.push(update);
      } else if (typeof update.text === 'string') {
        text.push(update.text);
      }
    }

    if (!text.length && typeof rpcResult?.content === 'string') text.push(rpcResult.content);
    if (!text.length && typeof rpcResult?.text === 'string') text.push(rpcResult.text);

    return {
      sessionId,
      text: text.join(''),
      stopReason: rpcResult?.stopReason || rpcResult?.stop_reason || null,
      toolCalls,
      metadata: state.metadata,
      raw: rpcResult,
    };
  }
}
