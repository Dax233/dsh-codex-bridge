import test from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, clip, readConfig, singleLine, tokensLabel, usageTotal } from '../lib/util.mjs';
import { parseExecEvents, summarizeEvents } from '../lib/rollout.mjs';

test('clip marks truncation', () => {
  assert.equal(clip('abcdef', 3), 'abc…');
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip(undefined, 3), '');
});

test('singleLine collapses whitespace', () => {
  assert.equal(singleLine('  a\n\tb  ', 20), 'a b');
  assert.equal(singleLine('a'.repeat(10), 5), 'aaaaa…');
});

test('ageLabel buckets', () => {
  assert.equal(ageLabel(-1), '—');
  assert.equal(ageLabel(1_500), '2s');
  assert.equal(ageLabel(90_000), '2m');
  assert.equal(ageLabel(5_400_000), '1.5h');
  assert.equal(ageLabel(2 * 86_400_000), '2.0d');
});

test('tokensLabel buckets', () => {
  assert.equal(tokensLabel(0), '—');
  assert.equal(tokensLabel(999), '999');
  assert.equal(tokensLabel(1_500), '1.5k');
  assert.equal(tokensLabel(2_500_000), '2.50M');
});

test('usageTotal tolerates CLI field-name differences', () => {
  assert.equal(usageTotal({ total_tokens: 12 }), 12);
  assert.equal(usageTotal({ totalTokens: 7 }), 7);
  assert.equal(usageTotal({ input_tokens: 17457, output_tokens: 9 }), 17466);
  assert.equal(usageTotal({ input_tokens: 5 }), 5);
  assert.equal(usageTotal({}), undefined);
  assert.equal(usageTotal(undefined), undefined);
});

test('readConfig applies defaults and normalizes env', () => {
  const config = readConfig({});
  assert.equal(config.approvalPolicy, 'never');
  assert.equal(config.maxOutputBytes, 1_048_576);
  assert.equal(config.allowNudge, false);
  assert.deepEqual(config.env, {});
  assert.ok(config.liveness.idleMs >= 60_000);
  const custom = readConfig({ approvalPolicy: 'on-request', allowNudge: true, env: { A: 1, B: true, C: null } });
  assert.equal(custom.approvalPolicy, 'on-request');
  assert.equal(custom.allowNudge, true);
  assert.deepEqual(custom.env, { A: '1', B: 'true' });
});

test('parseExecEvents extracts thread, final message, usage', () => {
  const text = [
    JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }),
    JSON.stringify({ type: 'turn.completed', usage: { total_tokens: 12 } }),
  ].join('\n');
  assert.deepEqual(parseExecEvents(text), {
    threadId: 'abc',
    finalMessage: 'OK',
    usage: { total_tokens: 12 },
    error: undefined,
  });
  assert.equal(parseExecEvents('not json').threadId, undefined);
  assert.equal(parseExecEvents(JSON.stringify({ type: 'error', message: 'boom' })).error, 'boom');
});

test('summarizeEvents reads messages and filters kinds', () => {
  const lines = [
    JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { cwd: 'C:\\w', session_id: 's1' } }),
    JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
    JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<heartbeat>ping</heartbeat>' }] } }),
    JSON.stringify({ timestamp: 't3', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }),
  ];
  const all = summarizeEvents(lines, { limit: 10 });
  assert.equal(all.meta.cwd, 'C:\\w');
  assert.deepEqual(all.items.map((item) => item.kind), ['user', 'heartbeat', 'turn-end']);
  const onlyUser = summarizeEvents(lines, { limit: 10, kinds: ['user'] });
  assert.deepEqual(onlyUser.items.map((item) => item.kind), ['user']);
  assert.equal(all.lastEventAt, 't3');
});
