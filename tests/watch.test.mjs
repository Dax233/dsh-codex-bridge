import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatch, parseHeartbeats } from '../scripts/watch.mjs';

const NOW = Date.parse('2026-10-25T06:00:00Z');
const HOUR = 3600000;
const thread = (over) => Object.assign({
  id: 'aaaaaaaa-0000-7000-8000-000000000001',
  name: 'seori',
  lastActivityMs: NOW - 10 * 60000,
  automations: [{ id: 'seori', status: 'ACTIVE' }],
  rollout: { file: 'fixture', sizeBytes: 1000, mtimeMs: NOW - 10 * 60000 },
}, over ?? {});
const template = [
  'STAGE: 评价参照与增量资格核清 | 进展=有（有限） | 证据=docs/x.md:3',
  'S: a / b / c / d / e',
  'D: a / b / c / d / e',
  'K: a / b / c / d / e',
  'F: 无新单元（本人未选）',
  'SUPPORT: runtime',
  'GAPS: none',
  'CHECK: threads x/y | no drift | 全量=未知',
  'ASOF: 2026-10-25T05:34Z',
].join('\n');
const beat = (over) => Object.assign({
  at: new Date(NOW - 20 * 60000).toISOString(),
  atMs: NOW - 20 * 60000,
  decision: 'NOTIFY',
  message: '新增强简单对照收窄了一项来源策略采用论证；共同阶段尚无新增准入。',
  text: template,
}, over ?? {});
const goals = [
  { threadId: 'aaaaaaaa-0000-7000-8000-000000000001', status: 'active' },
  { threadId: 'bbbbbbbb-0000-7000-8000-000000000002', status: 'active' },
  { threadId: 'cccccccc-0000-7000-8000-000000000003', status: 'active' },
  { threadId: 'dddddddd-0000-7000-8000-000000000004', status: 'active' },
  { threadId: 'eeeeeeee-0000-7000-8000-000000000005', status: 'blocked' },
];
const threads = [
  { id: 'aaaaaaaa-0000-7000-8000-000000000001', name: 'seori' },
  { id: 'bbbbbbbb-0000-7000-8000-000000000002', name: 'sia' },
  { id: 'cccccccc-0000-7000-8000-000000000003', name: 'danny' },
  { id: 'dddddddd-0000-7000-8000-000000000004', name: 'kiri' },
  { id: 'eeeeeeee-0000-7000-8000-000000000005', name: 'fei' },
];
const base = (over) => Object.assign({
  now: NOW,
  thread: thread(),
  threads: threads,
  goals: goals,
  heartbeats: [beat()],
  config: { staleAfterMs: 90 * 60000, idleAfterMs: 2 * HOUR },
}, over ?? {});
const codes = (result) => result.alerts.map((alert) => alert.code);

test('clean state produces no alerts', () => {
  const result = evaluateWatch(base());
  assert.deepEqual(codes(result), []);
  assert.equal(result.ok, true);
});

test('stale heartbeat and inactive automation are runtime alerts', () => {
  const stale = evaluateWatch(base({ heartbeats: [beat({ atMs: NOW - 3 * HOUR, at: new Date(NOW - 3 * HOUR).toISOString() })] }));
  assert.deepEqual(codes(stale), ['heartbeat_stale']);
  const off = evaluateWatch(base({ thread: thread({ automations: [{ id: 'seori', status: 'PAUSED' }] }) }));
  assert.deepEqual(codes(off), ['automation_inactive']);
});

test('NOTIFY heartbeat missing template keys or evidence is flagged', () => {
  const missing = evaluateWatch(base({ heartbeats: [beat({ text: 'STAGE: x | 进展=有（有限） | 证据=docs/x.md:3\nCHECK: y' })] }));
  assert.ok(codes(missing).includes('template_missing'));
  const noEvidence = evaluateWatch(base({ heartbeats: [beat({ text: template.replace('docs/x.md:3', '既有结果') })] }));
  assert.ok(codes(noEvidence).includes('stage_no_evidence'));
  const generic = evaluateWatch(base({ heartbeats: [beat({ text: '研究仍在推进，四位均有接续。' })] }));
  assert.ok(codes(generic).includes('template_missing'));
});

test('three stalled substantive heartbeats produce an info alert', () => {
  const stalledBeat = (minutes) => beat({
    atMs: NOW - minutes * 60000,
    at: new Date(NOW - minutes * 60000).toISOString(),
    text: template.replace('进展=有（有限）', '进展=未推进'),
  });
  const result = evaluateWatch(base({ heartbeats: [stalledBeat(60), stalledBeat(40), stalledBeat(20)] }));
  assert.ok(codes(result).includes('stage_stalled'));
});

test('goal drift and missing goal rows are flagged', () => {
  const drift = evaluateWatch(base({ goals: goals.map((row) => (row.status === 'active' ? Object.assign({}, row, { status: 'paused' }) : row)) }));
  assert.ok(codes(drift).includes('goal_drift'));
  const missing = evaluateWatch(base({ goals: goals.slice(0, 2) }));
  assert.ok(codes(missing).includes('goal_missing'));
});

test('missing rollout skips heartbeat checks with a warning', () => {
  const result = evaluateWatch(base({ thread: thread({ rollout: undefined }), heartbeats: [] }));
  assert.ok(codes(result).includes('rollout_missing'));
  assert.ok(codes(result).includes('heartbeat_missing'));
});

test('parseHeartbeats extracts decision and message from rollout rows', () => {
  const line = JSON.stringify({
    timestamp: '2026-10-25T05:35:32.139Z',
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: '<heartbeat>\n<automation_id>seori</automation_id>\n<decision>NOTIFY</decision>\n<message>STAGE: x</message>\n</heartbeat>' },
  });
  const beats = parseHeartbeats([line]);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].decision, 'NOTIFY');
  assert.equal(beats[0].message, 'STAGE: x');
  assert.ok(beats[0].text.includes('<heartbeat>'));
  assert.ok(beats[0].text.includes('STAGE: x'));
});

test('real heartbeat with template outside <message> yields no template alert', () => {
  const ts = new Date(NOW - 20 * 60000).toISOString();
  const line = JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: template + '\n\n<heartbeat>\n<automation_id>seori</automation_id>\n<decision>NOTIFY</decision>\n<message>新增强简单对照收窄了一项来源策略采用论证；共同阶段尚无新增准入。</message>\n</heartbeat>',
    },
  });
  const beats = parseHeartbeats([line]);
  const result = evaluateWatch(base({ heartbeats: beats }));
  assert.deepEqual(codes(result), []);
});
