#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { KiroACPClient } from './acp-client.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL_ID = process.env.MODEL_ID || 'kiro';
const MODEL_PREFIX = process.env.MODEL_PREFIX || 'kiroz/';
const KIRO_CWD = process.env.KIRO_CWD || process.cwd();
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10 * 60 * 1000);

// Kiro-supported models with metadata
const KIRO_MODELS = [
  { id: 'auto',                credits: null,   description: 'Auto-select the best model' },
  { id: 'claude-opus-4.7',     credits: 2.20,   description: 'Experimental preview of Claude Opus 4.7' },
  { id: 'claude-opus-4.6',     credits: 2.20,   description: 'The Claude Opus 4.6 model' },
  { id: 'claude-sonnet-4.6',   credits: 1.30,   description: 'The latest Claude Sonnet model with 1M context' },
  { id: 'claude-opus-4.5',     credits: 2.20,   description: 'The Claude Opus 4.5 model' },
  { id: 'claude-sonnet-4.5',   credits: 1.30,   description: 'The Claude Sonnet 4.5 model' },
  { id: 'claude-sonnet-4',     credits: 1.30,   description: 'Hybrid reasoning and coding for regular use' },
  { id: 'claude-haiku-4.5',    credits: 0.40,   description: 'The latest Claude Haiku model' },
  { id: 'deepseek-3.2',        credits: 0.25,   description: 'Experimental preview of DeepSeek V3.2' },
  { id: 'minimax-m2.5',        credits: 0.25,   description: 'The MiniMax M2.5 model' },
  { id: 'minimax-m2.1',        credits: 0.15,   description: 'Experimental preview of MiniMax M2.1' },
  { id: 'glm-5',               credits: 0.50,   description: 'The GLM-5 model' },
  { id: 'qwen3-coder-next',    credits: 0.05,   description: 'Experimental preview of Qwen3 Coder Next' },
];

function resolveModel(model) {
  // Strip prefix if present (e.g. "kiroz/claude-sonnet-4.5" -> "claude-sonnet-4.5")
  const kiroModel = model.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : model;
  // Validate against known models; fall back to MODEL_ID (default)
  const found = KIRO_MODELS.find((m) => m.id === kiroModel);
  return found ? kiroModel : MODEL_ID;
}

const clients = new Map(); // sessionId -> KiroACPClient

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${API_KEY}`;
}

function messagesToPrompt(messages = []) {
  return messages
    .filter((m) => typeof m?.content === 'string' || Array.isArray(m?.content))
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((p) => p?.text || '').filter(Boolean).join('\n')
        : m.content;
      return `${m.role?.toUpperCase?.() || 'USER'}:\n${content}`;
    })
    .join('\n\n');
}

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function getClient(sessionId) {
  if (sessionId && clients.has(sessionId)) return { sessionId, client: clients.get(sessionId), created: false };

  const client = new KiroACPClient({ cwd: KIRO_CWD });
  client.on('stderr', (chunk) => {
    if (process.env.DEBUG) process.stderr.write(`[kiro] ${chunk}`);
  });
  await client.start();
  const sid = sessionId || await client.newSession({ cwd: KIRO_CWD });
  if (sessionId) await client.loadSession(sessionId, { cwd: KIRO_CWD }).catch(async () => client.newSession({ cwd: KIRO_CWD }));
  clients.set(sid, client);
  return { sessionId: sid, client, created: true };
}

function chatResponse({ id, model, text, sessionId, metadata }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || '' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    kiro: { session_id: sessionId, metadata },
  };
}

async function handleChat(req, res, body) {
  const id = `chatcmpl-${randomUUID()}`;
  const requestedModel = body.model || MODEL_ID;
  const kiroModel = resolveModel(requestedModel);
  const sessionId = body.session_id || body.kiro_session_id || req.headers['x-kiro-session-id'];
  const prompt = body.prompt || messagesToPrompt(body.messages || []);
  if (!prompt.trim()) return json(res, 400, { error: { message: 'messages or prompt is required' } });

  const { sessionId: sid, client } = await getClient(sessionId);

  if (body.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-kiro-session-id': sid,
    });
    sse(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    const result = await client.prompt(sid, prompt, { timeoutMs: REQUEST_TIMEOUT_MS, model: kiroModel });
    sse(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: result.text || '' }, finish_reason: null }], kiro: { session_id: sid, metadata: result.metadata } });
    sse(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
    return;
  }

  const result = await client.prompt(sid, prompt, { timeoutMs: REQUEST_TIMEOUT_MS, model: kiroModel });
  return json(res, 200, chatResponse({ id, model: requestedModel, text: result.text, sessionId: sid, metadata: result.metadata }), { 'x-kiro-session-id': sid });
}

async function router(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (!checkAuth(req)) return json(res, 401, { error: { message: 'Unauthorized' } });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const data = KIRO_MODELS.map((m) => ({
        id: `${MODEL_PREFIX}${m.id}`,
        object: 'model',
        created: 0,
        owned_by: 'kiro-openai-proxy',
        kiro: { credits: m.credits, description: m.description },
      }));
      return json(res, 200, { object: 'list', data });
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const body = await readBody(req);
      return await handleChat(req, res, body);
    }

    return json(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: { message: err.message || 'Internal error', details: err.details } });
  }
}

const server = http.createServer(router);
server.listen(PORT, HOST, () => {
  console.log(`kiro-openai-proxy listening on http://${HOST}:${PORT}`);
  console.log(`model=${MODEL_ID} cwd=${KIRO_CWD}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
async function shutdown() {
  server.close();
  await Promise.allSettled([...clients.values()].map((c) => c.stop()));
  process.exit(0);
}
