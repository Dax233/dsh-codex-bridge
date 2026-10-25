import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, evaluateWatch, parseHeartbeats } from '../scripts/watch.mjs';

const NOW = Date.parse('2026-10-25T06:00:00Z');
const HOUR = 3600000;

/** Structural receipt shared by the fixtures; no deployment-specific wording. */
const template = [
  'STAGE: step description | 进展=有（有限） | 证据=docs/x.md:3',
  'SUPPORT: runtime',
  'GAPS: none',
  'CHECK: threads x/y | no drift | 全量=未知',
  'ASOF: 2026-10-25T05:34Z',
].join('\n');

const IDs = {
  relay: 'aaaaaaaa-0000-7000-8000-000000000001',
  alpha: 'bbbbbbbb-0000-7000-8000-000000000002',
  beta: 'cccccccc-0000-7000-8000-000000000003',
  gamma: 'dddddddd-0000-7000-8000-000000000004',
  delta: 'eeeeeeee-0000-7000-8000-000000000005',
};

const thread = (over) => Object.assign({
  id: IDs.relay,
  name: 'relay',
  lastActivityMs: NOW - 10 * 60000,
  automations: [{ id: 'relay', status: 'ACTIVE' }],
  rollout: { file: 'fixture', sizeBytes: 1000, mtimeMs: NOW - 10 * 60000 },
}, over ?? {});

const beat = (over) => Object.assign({
  at: new Date(NOW - 20 * 60000).toISOString(),
  atMs: NOW - 20 * 60000,
  decision: 'NOTIFY',
  message: 'heartbeat summary',
  text: template,
}, over ?? {});

const goals = [
  { threadId: IDs.relay, status: 'active' },
  { threadId: IDs.alpha, status: 'active' },
  { threadId: IDs.beta, status: 'active' },
  { threadId: IDs.gamma, status: 'active' },
  { threadId: IDs.delta, status: 'blocked' },
];

const threads = [
  { id: IDs.relay, name: 'relay' },
  { id: IDs.alpha, name: 'alpha' },
  { id: IDs.beta, name: 'beta' },
  { id: IDs.gamma, name: 'gamma' },
  { id: IDs.delta, name: 'delta' },
];

const base = (over) => Object.assign({
  now: NOW,
  thread: thread(),
  threads: threads,
  goals: goals,
  heartbeats: [beat()],
  config: {
    staleAfterMs: 90 * 60000,
    idleAfterMs: 2 * HOUR,
    requiredTemplateKeys: ['STAGE:', 'SUPPORT:', 'GAPS:', 'CHECK:', 'ASOF:'],
    expectedGoals: { alpha: 'active', beta: 'active', gamma: 'active', delta: 'blocked' },
  },
}, over ?? {});

const codes = (result) => result.alerts.map((alert) => alert.code);

test('DEFAULT_CONFIG contains no deployment-specific values', () => {
  assert.equal(DEFAULT_CONFIG.thread, '');
  assert.deepEqual(DEFAULT_CONFIG.expectedGoals, {});
  assert.deepEqual(DEFAULT_CONFIG.requiredTemplateKeys, []);
  assert.deepEqual(DEFAULT_CONFIG.genericPatterns, []);
});

test('clean state produces no alerts', () => {
  const result = evaluateWatch(base());
  assert.deepEqual(codes(result), []);
  assert.equal(result.ok, true);
});

test('template and goal checks are opt-in', () => {
  const plain = base({ config: {}, heartbeats: [beat({ text: 'short receipt without the configured keys' })] });
  assert.deepEqual(codes(evaluateWatch(plain)), []);
});

test('stale heartbeat and inactive automation are runtime alerts', () => {
  const stale = evaluateWatch(base({ heartbeats: [beat({ atMs: NOW - 3 * HOUR, at: new Date(NOW - 3 * HOUR).toISOString() })] }));
  assert.deepEqual(codes(stale), ['heartbeat_stale']);
  const off = evaluateWatch(base({ thread: thread({ automations: [{ id: 'relay', status: 'PAUSED' }] }) }));
  assert.deepEqual(codes(off), ['automation_inactive']);
});

test('NOTIFY heartbeat missing template keys or evidence is flagged', () => {
  const missing = evaluateWatch(base({ heartbeats: [beat({ text: 'STAGE: x | 进展=有（有限） | 证据=docs/x.md:3\nCHECK: y' })] }));
  assert.ok(codes(missing).includes('template_missing'));
  const noEvidence = evaluateWatch(base({ heartbeats: [beat({ text: template.replace('docs/x.md:3', '既有结果') })] }));
  assert.ok(codes(noEvidence).includes('stage_no_evidence'));
  const generic = evaluateWatch(base({ heartbeats: [beat({ text: 'plain generic progress report without the configured receipt keys' })] }));
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
    payload: { type: 'task_complete', last_agent_message: '<heartbeat>\n<automation_id>relay</automation_id>\n<decision>NOTIFY</decision>\n<message>STAGE: x</message>\n</heartbeat>' },
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
      last_agent_message: template + '\n\n<heartbeat>\n<automation_id>relay</automation_id>\n<decision>NOTIFY</decision>\n<message>short summary</message>\n</heartbeat>',
    },
  });
  const beats = parseHeartbeats([line]);
  const result = evaluateWatch(base({ heartbeats: beats }));
  assert.deepEqual(codes(result), []);
});

test('stalled detection reads the full agent message, not only <message>', () => {
  const line = (minutes) => JSON.stringify({
    timestamp: new Date(NOW - minutes * 60000).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: template.replace('进展=有（有限）', '进展=未推进') + '\n<heartbeat>\n<decision>NOTIFY</decision>\n<message>short summary</message>\n</heartbeat>',
    },
  });
  const beats = parseHeartbeats([line(60), line(40), line(20)]);
  const result = evaluateWatch(base({ heartbeats: beats }));
  assert.ok(codes(result).includes('stage_stalled'));
});
