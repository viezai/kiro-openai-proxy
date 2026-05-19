import test from 'node:test';
import assert from 'node:assert/strict';

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

test('messagesToPrompt renders OpenAI messages', () => {
  assert.equal(
    messagesToPrompt([
      { role: 'system', content: 'be useful' },
      { role: 'user', content: 'hello' },
    ]),
    'SYSTEM:\nbe useful\n\nUSER:\nhello',
  );
});
