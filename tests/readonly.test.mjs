
/**
 * Offline read-plane verification for dsh-codex-bridge (matrix items A1-A6).
 *
 * Every scenario runs against a throw-away fixture Codex home under os.tmpdir();
 * the suite never reads the real CODEX_HOME, never spawns codex, and consumes
 * no model turns. Tool behaviour is exercised through the real plugin entry
 * (index.js apply + the registered codex_* tools) with a mock cordis context.
 *
 * Run with: node --test tests/readonly.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply } from '../index.js';
import { buildCatalog, resolveThread } from '../lib/catalog.mjs';
import { findCodexExecutable, readGoals, resolveCodexHome } from '../lib/codex-home.mjs';
import { readSessionMeta, readTailLines, summarizeEvents } from '../lib/rollout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const LIB_URL = (name) => pathToFileURL(path.join(REPO_ROOT, 'lib', name)).href;
const INDEX_URL = pathToFileURL(path.join(REPO_ROOT, 'index.js')).href;
const EXE_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/* ── generic helpers ───────────────────────────────────────────────────── */

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-readonly-'));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  });
  return root;
}

function makeHome(t) {
  const home = path.join(makeRoot(t), 'codex-home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  return home;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function stampOf(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function uuid(index) {
  const tail = String(index).padStart(12, '0');
  return 'a0b1c2d3-e4f5-4678-9abc-' + tail;
}

function addExecutable(home) {
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, EXE_NAME);
  fs.writeFileSync(file, '');
  return file;
}

function addIndex(home, entries) {
  const lines = entries.map((entry) =>
    JSON.stringify({
      id: entry.id,
      thread_name: entry.name ?? '',
      updated_at: entry.updatedAt ?? iso(Date.now()),
    }),
  );
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), lines.join('\n') + '\n');
}

function addRollout(home, { id, rows, mtimeMs, subdir = path.join('sessions', '2026', '10', '24') }) {
  const dir = path.join(home, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-10-24T12-00-00-' + id + '.jsonl');
  fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n');
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function addLock(home, id, mtimeMs = Date.now()) {
  const dir = path.join(home, 'thread-writer-locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.lock');
  fs.writeFileSync(file, '');
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

function addAutomation(home, { dirName, id, status, targetThreadId }) {
  const dir = path.join(home, 'automations', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'automation.toml'),
    ['id = "' + id + '"', 'kind = "heartbeat"', 'status = "' + status + '"', 'target_thread_id = "' + targetThreadId + '"'].join('\n') + '\n',
  );
}

async function addGoals(home, rows, { filename = 'goals_1.sqlite', schema = 'good' } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path.join(home, filename));
  try {
    if (schema === 'good') {
      database.exec(
        'CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, tokens_used INTEGER, updated_at_ms INTEGER)',
      );
      const insert = database.prepare(
        'INSERT INTO thread_goals (thread_id, goal_id, objective, status, tokens_used, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insert.run(
          row.threadId,
          row.goalId ?? 'goal-' + row.threadId,
          row.objective ?? '',
          row.status ?? 'active',
          row.tokensUsed ?? 0,
          row.updatedAtMs ?? 0,
        );
      }
    } else {
      database.exec('CREATE TABLE unrelated (value TEXT)');
    }
  } finally {
    database.close();
  }
}

function metaRow(id, { at = Date.now() - 3_600_000, cwd = 'C:\\fixture\\work', cliVersion = '9.9.9-test', provider = 'fixture-provider' } = {}) {
  return {
    timestamp: iso(at),
    type: 'session_meta',
    payload: { session_id: id, cwd, cli_version: cliVersion, model_provider: provider },
  };
}

function userRow(text, at) {
  return { timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] } };
}

function assistantRow(text, at) {
  return { timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] } };
}

function developerRow(text, at) {
  return { timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'text', text }] } };
}

function toolRow(name, at) {
  return { timestamp: iso(at), type: 'response_item', payload: { type: 'custom_tool_call', name } };
}

function turnEndRow(text, at) {
  return { timestamp: iso(at), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } };
}

/* ── mock cordis host + tool parsing ──────────────────────────────────── */

function fakeSpawnHandle() {
  return {
    collected: {
      stdout: { readFrom: () => ({ text: '', lossy: false }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
    done: new Promise(() => {}),
  };
}

function createHarness(config) {
  const registry = new Map();
  const spawns = [];
  const context = {
    effect(handler) {
      handler();
    },
    get() {
      return undefined;
    },
    tools: {
      register(definition) {
        registry.set(definition.name, definition);
        return { dispose() {} };
      },
    },
    subprocess: {
      spawn(options) {
        spawns.push(options);
        return fakeSpawnHandle();
      },
    },
  };
  apply(context, config);
  const call = async (name, args = {}) => {
    const definition = registry.get(name);
    assert.ok(definition, 'tool ' + name + ' must be registered');
    const value = await definition.execute(args, {});
    return value.text;
  };
  return { registry, spawns, call };
}

const THREAD_ROW_RE =
  /^(.+?)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+goal=(\S+)\s+last=(\S+)\s+size=(\S+)\s+auto=(\S+)(?:\s+(\S+))?\s*$/iu;
const GOAL_ROW_RE =
  /^(.+?)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(active|blocked|paused|completed)\s+(\S+) tokens\s+updated (\S+) ago(?:\s(.*))?$/u;
const LIVENESS_ROW_RE = /^(.+?)\s+goal=(\S+)\s+last=(\S+)\s+(.+)$/u;
const READ_ITEM_RE = /^\d\d-\d\d \d\d:\d\d \[([a-z-]+)\] (.*)$/u;
const READ_HEADER_RE = /^(thread|cwd|rollout|goal|last event): (.*)$/u;

function parseThreadRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(THREAD_ROW_RE);
    if (!match) continue;
    rows.push({
      name: match[1].trim(),
      id: match[2],
      goal: match[3],
      last: match[4],
      size: match[5],
      auto: match[6],
      running: match[7] ?? '',
      raw: line,
    });
  }
  return rows;
}

function parseGoalRows(text) {
  if (!text.startsWith('goal rows')) return [];
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const match = line.match(GOAL_ROW_RE);
    if (!match) continue;
    rows.push({ name: match[1].trim(), id: match[2], status: match[3], tokens: match[4], last: match[5], objective: match[6] ?? '' });
  }
  return rows;
}

function parseLiveness(text) {
  const lines = text.split('\n');
  const header = lines[0];
  const rows = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('  nudged ->')) continue;
    const match = line.match(LIVENESS_ROW_RE);
    if (match) rows.push({ label: match[1].trim(), goal: match[2], last: match[3], verdict: match[4] });
  }
  return { header, rows };
}

function parseRead(text) {
  const header = {};
  const items = [];
  const notes = [];
  for (const line of text.split('\n')) {
    const head = line.match(READ_HEADER_RE);
    if (head) {
      header[head[1]] = head[2];
      continue;
    }
    const item = line.match(READ_ITEM_RE);
    if (item) {
      items.push({ kind: item[1], text: item[2] });
      continue;
    }
    if (line.startsWith('(tail window') || line.startsWith('(whole file read') || line.startsWith('(no matching items')) notes.push(line);
  }
  return { header, items, notes };
}

function clipped(text, max) {
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

/* ── A1: home / executable resolution and degraded modes ─────────────── */

test('A1 resolveCodexHome honours config.codexHome before CODEX_HOME', (t) => {
  const root = makeRoot(t);
  const configured = path.join(root, 'configured-home');
  const fromEnv = path.join(root, 'env-home');
  fs.mkdirSync(configured, { recursive: true });
  fs.mkdirSync(fromEnv, { recursive: true });
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = fromEnv;
    assert.equal(resolveCodexHome(configured), path.resolve(configured));
    assert.equal(resolveCodexHome(''), path.resolve(fromEnv));
    assert.equal(resolveCodexHome(path.join(root, 'missing-home')), path.resolve(fromEnv));
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test('A1 resolveCodexHome falls back to the home directory, or undefined when absent', (t) => {
  const root = makeRoot(t);
  const fakeUserHome = path.join(root, 'user-home');
  fs.mkdirSync(path.join(fakeUserHome, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(root, 'configured-home'), { recursive: true });
  fs.mkdirSync(path.join(root, 'env-home'), { recursive: true });
  const probe = writeProbe(t, root);
  const result = runProbe(t, probe, {
    mode: 'resolve-home',
    modHome: LIB_URL('codex-home.mjs'),
    fakeUserHome,
    scenarios: [
      { name: 'configured', configured: path.join(root, 'configured-home'), envCodexHome: path.join(root, 'env-home') },
      { name: 'env', configured: '', envCodexHome: path.join(root, 'env-home') },
      { name: 'homedir', configured: '', envCodexHome: null },
      { name: 'missing', configured: path.join(root, 'missing-home'), envCodexHome: null, removeHomedirCodex: true },
    ],
  });
  const byName = Object.fromEntries(result.scenarios.map((scenario) => [scenario.name, scenario.result]));
  assert.equal(byName.configured, path.resolve(root, 'configured-home'));
  assert.equal(byName.env, path.resolve(root, 'env-home'));
  assert.equal(byName.homedir, path.resolve(fakeUserHome, '.codex'));
  assert.equal(byName.missing, null);
});

test('A1 findCodexExecutable probes config, CODEX_BIN, desktop bundle, PATH, then home bins', (t) => {
  const root = makeRoot(t);
  const fakeUserHome = path.join(root, 'user-home');
  fs.mkdirSync(fakeUserHome, { recursive: true });
  const configuredBin = path.join(root, 'configured-bin', EXE_NAME);
  const envBin = path.join(root, 'env-bin', EXE_NAME);
  const pathBin = path.join(root, 'path-bin', EXE_NAME);
  const bundledBin = path.join(root, 'desktop', 'OpenAI', 'Codex', 'bin', 'v1', EXE_NAME);
  const userBin = path.join(fakeUserHome, '.local', 'bin', EXE_NAME);
  for (const file of [configuredBin, envBin, pathBin, bundledBin, userBin]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  const fixtureHome = path.join(root, 'fixture-home');
  fs.mkdirSync(path.join(fixtureHome, '.sandbox-bin'), { recursive: true });
  const sandboxBin = path.join(fixtureHome, '.sandbox-bin', EXE_NAME);
  fs.writeFileSync(sandboxBin, '');
  const otherHome = path.join(root, 'other-home');
  fs.mkdirSync(otherHome, { recursive: true });
  const probe = writeProbe(t, root);
  const result = runProbe(t, probe, {
    mode: 'find-exe',
    modHome: LIB_URL('codex-home.mjs'),
    fakeUserHome,
    scenarios: [
      { name: 'configured', configured: configuredBin, env: { CODEX_BIN: envBin, LOCALAPPDATA: path.join(root, 'desktop') }, home: fixtureHome },
      { name: 'codxB', configured: '', env: { CODEX_BIN: envBin, LOCALAPPDATA: path.join(root, 'desktop') }, home: fixtureHome },
      { name: 'desktop', configured: '', env: { CODEX_BIN: '', LOCALAPPDATA: path.join(root, 'desktop') }, home: fixtureHome },
      { name: 'path', configured: '', env: { CODEX_BIN: '', LOCALAPPDATA: '', PATH: path.dirname(pathBin) }, home: fixtureHome },
      { name: 'userBin', configured: '', env: { CODEX_BIN: '', LOCALAPPDATA: '', PATH: '' }, home: fixtureHome },
      { name: 'homeBin', configured: '', env: { CODEX_BIN: '', LOCALAPPDATA: '', PATH: '' }, home: fixtureHome, deletePaths: [userBin] },
      { name: 'none', configured: '', env: { CODEX_BIN: '', LOCALAPPDATA: '', PATH: '' }, home: otherHome },
    ],
  });
  const byName = Object.fromEntries(result.scenarios.map((scenario) => [scenario.name, scenario.result]));
  assert.equal(byName.configured, path.resolve(configuredBin));
  assert.equal(byName.codxB, path.resolve(envBin));
  if (process.platform === 'win32') assert.equal(byName.desktop, path.resolve(bundledBin));
  assert.equal(byName.path, path.resolve(pathBin));
  assert.equal(byName.userBin, path.resolve(userBin));
  assert.equal(byName.homeBin, path.resolve(sandboxBin));
  assert.equal(byName.none, null);
});

test('A1 missing home makes read tools fail clearly while a missing executable only blocks send', async (t) => {
  const root = makeRoot(t);
  const fakeUserHome = path.join(root, 'user-home');
  fs.mkdirSync(fakeUserHome, { recursive: true });
  const fixtureHome = path.join(root, 'fixture-home');
  fs.mkdirSync(path.join(fixtureHome, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureHome, 'session_index.jsonl'),
    JSON.stringify({ id: uuid(1), thread_name: 'probe', updated_at: iso(Date.now()) }) + '\n',
  );
  addRollout(fixtureHome, {
    id: uuid(1),
    rows: [metaRow(uuid(1)), userRow('hello', Date.now() - 2000), turnEndRow('done', Date.now() - 1000)],
    mtimeMs: Date.now() - 1000,
  });
  const probe = writeProbe(t, root);
  const base = {
    mode: 'tools',
    modHome: LIB_URL('codex-home.mjs'),
    modIndex: INDEX_URL,
    fakeUserHome,
    readThread: 'probe',
  };

  const missingHome = runProbe(t, probe, {
    ...base,
    env: { CODEX_HOME: '', CODEX_BIN: '', LOCALAPPDATA: '', PATH: '' },
    config: { codexHome: path.join(root, 'absent-home') },
  });
  assert.match(missingHome.tools.threads.error, /Codex home not found/);
  assert.match(missingHome.tools.read.error, /Codex home not found/);
  assert.match(missingHome.tools.goals.error, /Codex home not found/);
  assert.match(missingHome.tools.liveness.error, /Codex home not found/);
  assert.match(missingHome.tools.send.error, /codex executable not found/);

  const missingExecutable = runProbe(t, probe, {
    ...base,
    env: { CODEX_HOME: '', CODEX_BIN: '', LOCALAPPDATA: '', PATH: '' },
    config: { codexHome: fixtureHome },
  });
  assert.equal(missingExecutable.tools.threads.ok, true);
  assert.match(missingExecutable.tools.threads.text, /executable: \(not found\)/);
  assert.equal(missingExecutable.tools.read.ok, true);
  assert.match(missingExecutable.tools.read.text, /thread: probe/);
  assert.equal(missingExecutable.tools.goals.ok, true);
  assert.equal(missingExecutable.tools.liveness.ok, true);
  assert.match(missingExecutable.tools.send.error, /codex executable not found/);
});

/* ── A2: codex_threads catalog and filters ───────────────────────────── */

function buildThreeThreadHome(t) {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const now = Date.now();
  addIndex(home, [
    { id: uuid(1), name: 'alpha', updatedAt: iso(now - 1000) },
    { id: uuid(2), name: 'bravo', updatedAt: iso(now - 3_700_000) },
    { id: uuid(3), name: '', updatedAt: iso(now - 3 * 86_400_000) },
  ]);
  addRollout(home, {
    id: uuid(1),
    rows: [metaRow(uuid(1)), userRow('alpha message', now - 2000), turnEndRow('alpha done', now - 1000)],
    mtimeMs: now - 1000,
  });
  addRollout(home, {
    id: uuid(2),
    rows: [metaRow(uuid(2)), userRow('bravo message', now - 3_700_000), turnEndRow('bravo done', now - 3_600_000)],
    mtimeMs: now - 3_700_000,
  });
  addRollout(home, {
    id: uuid(3),
    rows: [metaRow(uuid(3)), userRow('charlie message', now - 3 * 86_400_000), turnEndRow('done', now - 3 * 86_400_000)],
    mtimeMs: now - 3 * 86_400_000,
  });
  addAutomation(home, { dirName: 'auto-charlie', id: 'auto-charlie', status: 'ACTIVE', targetThreadId: uuid(3) });
  return { home, exe, now };
}

test('A2 codex_threads lists names, goals, ages, sizes, automations in lastActivity order', async (t) => {
  const { home, exe } = buildThreeThreadHome(t);
  await addGoals(home, [{ threadId: uuid(2), status: 'active', tokensUsed: 1500, updatedAtMs: Date.now() - 3_700_000 }]);
  const harness = createHarness({ codexHome: home, executable: exe });
  const text = await harness.call('codex_threads', {});
  const rows = parseThreadRows(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.name), ['alpha', 'bravo', '(unnamed)']);
  assert.deepEqual(rows.map((row) => row.id), [uuid(1), uuid(2), uuid(3)]);
  assert.equal(rows[0].goal, '\u2014');
  assert.equal(rows[1].goal, 'active');
  assert.match(rows[0].last, /^[0-9]+s$/u);
  assert.equal(rows[2].auto, 'auto-charlie:ACTIVE');
  assert.match(text, /^home: /m);
  assert.equal(text.includes('executable: ' + exe), true);
  assert.match(text, /goals: 1 rows/);
  const firstRollout = path.join(home, 'sessions', '2026', '10', '24', 'rollout-2026-10-24T12-00-00-' + uuid(1) + '.jsonl');
  assert.equal(rows[0].size, (fs.statSync(firstRollout).size / 1_048_576).toFixed(1) + 'MB');
});

test('A2 query is case-insensitive over name and id substring', async (t) => {
  const { home, exe } = buildThreeThreadHome(t);
  const harness = createHarness({ codexHome: home, executable: exe });
  const byName = parseThreadRows(await harness.call('codex_threads', { query: 'ALPHA' }));
  assert.deepEqual(byName.map((row) => row.id), [uuid(1)]);
  const byId = parseThreadRows(await harness.call('codex_threads', { query: uuid(2).slice(-12).toUpperCase() }));
  assert.deepEqual(byId.map((row) => row.id), [uuid(2)]);
  const noMatch = await harness.call('codex_threads', { query: 'zzz-not-a-thread' });
  assert.match(noMatch, /^no Codex threads matched \(home: /);
});

test('A2 limit and activeWithinMinutes are clamped as documented', async (t) => {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const now = Date.now();
  const entries = [];
  for (let index = 0; index < 55; index += 1) {
    entries.push({ id: uuid(index), name: 't' + String(index).padStart(2, '0'), updatedAt: iso(now - index * 60_000) });
    addRollout(home, {
      id: uuid(index),
      rows: [metaRow(uuid(index)), userRow('m' + index, now - (index + 1) * 60_000)],
      mtimeMs: now - index * 60_000,
    });
  }
  addIndex(home, entries);
  const harness = createHarness({ codexHome: home, executable: exe });
  assert.equal(parseThreadRows(await harness.call('codex_threads', {})).length, 15);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { limit: 100 })).length, 50);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { limit: 0 })).length, 1);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { limit: -3 })).length, 1);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { limit: 2.5 })).length, 15);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { limit: 50 }))[0].name, 't00');

  const fiveMinutes = parseThreadRows(await harness.call('codex_threads', { activeWithinMinutes: 5, limit: 50 }));
  assert.equal(fiveMinutes.length, 5);
  assert.deepEqual(fiveMinutes.map((row) => row.name), ['t00', 't01', 't02', 't03', 't04']);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { activeWithinMinutes: 0, limit: 50 })).length, 50);
});

test('A2 running bridge turns are marked and drive the liveness running verdict', async (t) => {
  const { home, exe } = buildThreeThreadHome(t);
  const harness = createHarness({ codexHome: home, executable: exe });
  const sent = await harness.call('codex_send', { message: 'ping', thread: 'alpha' });
  assert.match(sent, /status: running/);
  assert.equal(harness.spawns.length, 1);
  assert.equal(harness.spawns[0].argv[0], exe);
  assert.deepEqual(harness.spawns[0].argv.slice(1, 5), ['exec', 'resume', '--json', '--skip-git-repo-check']);
  assert.equal(harness.spawns[0].argv.includes(uuid(1)), true);
  const marked = parseThreadRows(await harness.call('codex_threads', { query: 'alpha' }));
  assert.equal(marked[0].running, 'running');
  const live = parseLiveness(await harness.call('codex_liveness', { threads: ['alpha'] }));
  assert.match(live.rows[0].verdict, /^working \(bridge turn [0-9a-f-]{36}\)$/u);
  assert.equal(parseThreadRows(await harness.call('codex_threads', { query: 'bravo' }))[0].running, '');
});

test('A2 goals unavailability is shown in the codex_threads header', async (t) => {
  const { home, exe } = buildThreeThreadHome(t);
  const harness = createHarness({ codexHome: home, executable: exe });
  const text = await harness.call('codex_threads', {});
  assert.match(text, /goals unavailable \(no goals database found\)/);
});

/* ── A3: codex_read resolution, bounded tail, clamps, kinds ───────────── */

function addSparseRollout(home, { id, sizeBytes, marker }) {
  const dir = path.join(home, 'sessions', '2026', '10', '25');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-10-25T12-00-00-' + id + '.jsonl');
  const head = JSON.stringify(metaRow(id, { at: Date.now() - 3_600_000, cwd: 'C:\\fixture\\sparse' })) + '\n';
  fs.writeFileSync(file, head);
  fs.truncateSync(file, sizeBytes);
  const trailer = 'filler-filler\n' + JSON.stringify(turnEndRow(marker, Date.now() - 1_000_000)) + '\n';
  const handle = fs.openSync(file, 'r+');
  try {
    fs.writeSync(handle, Buffer.from(trailer), 0, Buffer.byteLength(trailer), sizeBytes - 400);
  } finally {
    fs.closeSync(handle);
  }
  fs.utimesSync(file, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  return file;
}

function buildReadHome(t) {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const now = Date.now();
  const convoRows = [metaRow(uuid(10), { at: now - 600_000, cwd: 'C:\\fixture\\convo', cliVersion: '9.9.9-test', provider: 'fixture-provider' })];
  for (let index = 0; index < 35; index += 1) {
    convoRows.push(userRow('user message ' + index, now - 500_000 + index * 1000));
    convoRows.push(assistantRow('assistant message ' + index, now - 499_000 + index * 1000));
  }
  const longText = 'L'.repeat(5000);
  convoRows.push(developerRow('developer instructions', now - 100_000));
  convoRows.push(toolRow('exec', now - 90_000));
  convoRows.push(assistantRow('<heartbeat>ping</heartbeat>', now - 80_000));
  convoRows.push(userRow(longText, now - 70_000));
  convoRows.push(turnEndRow('TURN-DONE', now - 60_000));
  addRollout(home, { id: uuid(10), rows: convoRows, mtimeMs: now - 60_000 });

  const bigRows = [metaRow(uuid(11), { at: now - 300_000 })];
  for (let index = 0; index < 150; index += 1) {
    bigRows.push(userRow('big-' + index + ' ' + 'x'.repeat(1000), now - 290_000 + index * 100));
  }
  bigRows.push(turnEndRow('BIG-TAIL', now - 200_000));
  addRollout(home, { id: uuid(11), rows: bigRows, mtimeMs: now - 200_000 });

  const hugeRows = [metaRow(uuid(12), { at: now - 400_000 })];
  for (let index = 0; index < 900; index += 1) {
    hugeRows.push(assistantRow('huge-' + index + ' ' + 'y'.repeat(10_000), now - 390_000 + index * 100));
  }
  hugeRows.push(turnEndRow('HUGE-TAIL', now - 300_000));
  addRollout(home, { id: uuid(12), rows: hugeRows, mtimeMs: now - 300_000 });

  addSparseRollout(home, { id: uuid(13), sizeBytes: 800 * 1024 * 1024, marker: 'SPARSE-TAIL-MARKER' });

  addIndex(home, [
    { id: uuid(10), name: 'convo', updatedAt: iso(now - 60_000) },
    { id: uuid(11), name: 'big', updatedAt: iso(now - 200_000) },
    { id: uuid(12), name: 'huge', updatedAt: iso(now - 300_000) },
    { id: uuid(13), name: 'sparse', updatedAt: iso(now - 400_000) },
    { id: uuid(14), name: 'noroll', updatedAt: iso(now - 500_000) },
  ]);
  return { home, exe, now };
}

test('A2 index-only threads report the session_index update age, not the epoch', async (t) => {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const now = Date.now();
  addIndex(home, [
    { id: uuid(70), name: 'archived', updatedAt: iso(now - 2 * 86_400_000) },
    { id: uuid(71), name: '', updatedAt: iso(now - 3_000_000) },
  ]);
  const harness = createHarness({ codexHome: home, executable: exe });
  const rows = parseThreadRows(await harness.call('codex_threads', {}));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, '(unnamed)', 'newest index update sorts first');
  assert.equal(rows.find((row) => row.name === '(unnamed)').last, '50m');
  assert.equal(rows.find((row) => row.name === 'archived').last, '2.0d');
  const recent = parseThreadRows(await harness.call('codex_threads', { activeWithinMinutes: 60 }));
  assert.deepEqual(recent.map((row) => row.name), ['(unnamed)']);
  const live = parseLiveness(await harness.call('codex_liveness', { threads: ['archived'] }));
  assert.match(live.rows[0].verdict, /^idle 2\.0d$/u);
});

test('A3 resolveThread accepts full id, id prefix, name, and @name', async (t) => {
  const { home, exe } = buildReadHome(t);
  const catalog = await buildCatalog(home);
  const fullId = uuid(10);
  assert.equal(resolveThread(catalog.threads, fullId).id, fullId);
  assert.equal(resolveThread(catalog.threads, fullId.slice(0, 8)).id, fullId);
  assert.equal(resolveThread(catalog.threads, 'convo').id, fullId);
  assert.equal(resolveThread(catalog.threads, '@convo').id, fullId);
  assert.equal(resolveThread(catalog.threads, 'CONVO').id, fullId);
  assert.equal(resolveThread(catalog.threads, 'no-such-thread'), undefined);
  assert.equal(resolveThread(catalog.threads, '   '), undefined);
  const harness = createHarness({ codexHome: home, executable: exe });
  for (const reference of [fullId, fullId.slice(0, 8), 'convo', '@convo']) {
    const read = parseRead(await harness.call('codex_read', { thread: reference }));
    assert.match(read.header.thread, new RegExp('^convo ' + fullId + '$', 'u'));
  }
  await assert.rejects(harness.call('codex_read', { thread: 'no-such-thread' }), /unknown Codex thread "no-such-thread"; named threads: .*convo/u);
  await assert.rejects(harness.call('codex_read', { thread: 'noroll' }), /has no local rollout file \(no transcript recorded\)/u);
});

test('A3 codex_read exposes header facts from session_meta, rollout, and goal rows', async (t) => {
  const { home, exe, now } = buildReadHome(t);
  await addGoals(home, [{ threadId: uuid(10), status: 'active', tokensUsed: 1234, updatedAtMs: now - 400_000, objective: 'probe objective' }]);
  const harness = createHarness({ codexHome: home, executable: exe });
  const read = parseRead(await harness.call('codex_read', { thread: 'convo' }));
  assert.match(read.header.thread, new RegExp('^convo ' + uuid(10) + '$', 'u'));
  assert.match(read.header.cwd, /^C:\\fixture\\convo  codex-cli 9\.9\.9-test  provider fixture-provider$/u);
  assert.match(read.header.rollout, /^0\.\d+MB  last write /u);
  assert.equal(read.header.goal, 'active (updated ' + stampOf(now - 400_000) + ', 1.2k tokens)');
  assert.equal(read.header['last event'].split(' ')[0], iso(now - 60_000));
  assert.deepEqual(read.items.at(-1), { kind: 'turn-end', text: 'TURN-DONE' });
  assert.ok(read.notes.includes('(whole file read)'));
  assert.equal(read.items.length, 12);
});

test('A3 codex_read clamps limit, maxChars, and tailBytes', async (t) => {
  const { home, exe } = buildReadHome(t);
  const harness = createHarness({ codexHome: home, executable: exe });
  assert.equal(parseRead(await harness.call('codex_read', { thread: 'convo', limit: 1 })).items.length, 1);
  assert.equal(parseRead(await harness.call('codex_read', { thread: 'convo', limit: 0 })).items.length, 1);
  assert.equal(parseRead(await harness.call('codex_read', { thread: 'convo', limit: 100 })).items.length, 40);
  assert.equal(parseRead(await harness.call('codex_read', { thread: 'convo', limit: 2.5 })).items.length, 12);
  const longText = 'L'.repeat(5000);
  const byDefault = parseRead(await harness.call('codex_read', { thread: 'convo', tailBytes: 1 })).items.find((item) => item.text.startsWith('L'));
  assert.equal(byDefault.text, clipped(longText, 600));
  const minChars = parseRead(await harness.call('codex_read', { thread: 'convo', maxChars: 1, limit: 40 })).items.find((item) => item.text.startsWith('L'));
  assert.equal(minChars.text, clipped(longText, 100));
  assert.equal(minChars.text.length, 101);
  const maxChars = parseRead(await harness.call('codex_read', { thread: 'convo', maxChars: 99_999, limit: 40 })).items.find((item) => item.text.startsWith('L'));
  assert.equal(maxChars.text, clipped(longText, 4000));
  assert.equal(maxChars.text.length, 4001);
  const tinyWindow = parseRead(await harness.call('codex_read', { thread: 'big', tailBytes: 1000 }));
  assert.ok(tinyWindow.notes.includes('(tail window 0.1MB; older items omitted)'));
  const eightMb = parseRead(await harness.call('codex_read', { thread: 'huge', tailBytes: 100_000_000 }));
  assert.ok(eightMb.notes.includes('(tail window 8.0MB; older items omitted)'));
  assert.deepEqual(eightMb.items.at(-1), { kind: 'turn-end', text: 'HUGE-TAIL' });
  const defaultLarge = parseRead(await harness.call('codex_read', { thread: 'huge' }));
  assert.ok(defaultLarge.notes.includes('(tail window 1.4MB; older items omitted)'));
});

test('A3 codex_read filters kinds and reports empty matches', async (t) => {
  const { home, exe } = buildReadHome(t);
  const harness = createHarness({ codexHome: home, executable: exe });
  const users = parseRead(await harness.call('codex_read', { thread: 'convo', kinds: ['user'], limit: 40 }));
  assert.equal(users.items.length, 36);
  assert.equal(users.items.every((item) => item.kind === 'user'), true);
  const ends = parseRead(await harness.call('codex_read', { thread: 'convo', kinds: ['turn-end'] }));
  assert.deepEqual(ends.items, [{ kind: 'turn-end', text: 'TURN-DONE' }]);
  const dev = parseRead(await harness.call('codex_read', { thread: 'convo', kinds: ['developer'] }));
  assert.deepEqual(dev.items, [{ kind: 'developer', text: 'developer instructions' }]);
  const emptyKinds = parseRead(await harness.call('codex_read', { thread: 'convo', kinds: [] }));
  assert.equal(emptyKinds.items.length, 12);
  const nothing = parseRead(await harness.call('codex_read', { thread: 'big', kinds: ['heartbeat'] }));
  assert.deepEqual(nothing.items, []);
  assert.ok(nothing.notes.includes('(no matching items in the tail window)'));
});

test('A3 the 800MB-class rollout is read from a bounded tail, not the whole file', async (t) => {
  const { home, exe } = buildReadHome(t);
  const harness = createHarness({ codexHome: home, executable: exe });
  const originalReadSync = fs.readSync;
  let bytesRead = 0;
  fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
    bytesRead += length;
    return originalReadSync.call(fs, fd, buffer, offset, length, position);
  };
  try {
    const startedAt = Date.now();
    const text = await harness.call('codex_read', { thread: 'sparse', tailBytes: 1_500_000 });
    const elapsed = Date.now() - startedAt;
    const read = parseRead(text);
    assert.match(read.header.rollout, /^800\.0MB  last write /u);
    assert.ok(read.notes.includes('(tail window 1.4MB; older items omitted)'));
    assert.equal(read.items.some((item) => item.text === 'SPARSE-TAIL-MARKER'), true);
    assert.ok(elapsed < 5_000, 'bounded read took ' + elapsed + 'ms');
    assert.ok(bytesRead < 5 * 1024 * 1024, 'read ' + bytesRead + ' bytes from an 800MB file');
  } finally {
    fs.readSync = originalReadSync;
  }
});

test('A3 readTailLines bounds bytes, drops the partial first line, and flags truncation', (t) => {
  const root = makeRoot(t);
  const file = path.join(root, 'tail.jsonl');
  fs.writeFileSync(file, 'aaaa\nbbbb\ncccc\ndddd\n');
  assert.deepEqual(readTailLines(file, 1024), { lines: ['aaaa', 'bbbb', 'cccc', 'dddd'], truncated: false, sizeBytes: 20 });
  const tail = readTailLines(file, 9);
  assert.equal(tail.truncated, true);
  assert.equal(tail.lines.includes('aaaa'), false);
  assert.equal(tail.lines.at(-1), 'dddd');

  const originalReadSync = fs.readSync;
  let bytesRead = 0;
  fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
    bytesRead += length;
    return originalReadSync.call(fs, fd, buffer, offset, length, position);
  };
  try {
    const result = readTailLines(file, 8);
    assert.ok(bytesRead <= 8, 'read ' + bytesRead + ' bytes for an 8-byte window');
    assert.equal(result.truncated, true);
  } finally {
    fs.readSync = originalReadSync;
  }
});

test('A3 readSessionMeta reads a session header line larger than one 64KB chunk', (t) => {
  const root = makeRoot(t);
  const file = path.join(root, 'meta.jsonl');
  const longCwd = 'C:\\' + 'x'.repeat(100_000);
  fs.writeFileSync(
    file,
    JSON.stringify({
      timestamp: '2026-10-24T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: uuid(20), cwd: longCwd, cli_version: '9.9.9-long', model_provider: 'provider-long' },
    }) + '\n',
  );
  const meta = readSessionMeta(file);
  assert.equal(meta.sessionId, uuid(20));
  assert.equal(meta.cwd, longCwd);
  assert.equal(meta.cliVersion, '9.9.9-long');
  assert.equal(meta.modelProvider, 'provider-long');
});

test('A3 summarizeEvents keeps chronological order and clips text', () => {
  const lines = [];
  for (let index = 0; index < 20; index += 1) {
    lines.push(JSON.stringify(index % 2 === 0 ? userRow('u' + index, index) : assistantRow('a' + index, index)));
  }
  const summary = summarizeEvents(lines, { limit: 5, maxChars: 1 });
  assert.deepEqual(summary.items.map((item) => item.kind), ['assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(summary.items.map((item) => item.text), ['a\u2026', 'u\u2026', 'a\u2026', 'u\u2026', 'a\u2026']);
  assert.equal(summary.lastEventAt, new Date(19).toISOString());
});

/* ── A4: codex_goals read-only rows, filters, clamps, degrade ─────────── */

function goalRowsFixture() {
  const base = 1_700_000_000_000;
  const rows = [];
  for (let index = 0; index < 220; index += 1) {
    rows.push({
      threadId: uuid(100 + index),
      status: index >= 20 ? 'active' : index >= 10 ? 'blocked' : 'paused',
      tokensUsed: index === 219 ? 2_500_000 : index * 1000,
      updatedAtMs: base + index * 1000,
      objective: 'objective ' + index + '\n second line',
    });
  }
  return rows;
}

test('A4 codex_goals reads rows newest-first and clamps limit', async (t) => {
  const home = makeHome(t);
  const exe = addExecutable(home);
  await addGoals(home, goalRowsFixture());
  addIndex(home, [{ id: uuid(100 + 219), name: 'goalnamed', updatedAt: iso(Date.now()) }]);
  const harness = createHarness({ codexHome: home, executable: exe });
  const defaults = parseGoalRows(await harness.call('codex_goals', {}));
  assert.equal(defaults.length, 40);
  assert.equal(defaults[0].id, uuid(100 + 219));
  assert.equal(defaults[0].status, 'active');
  assert.equal(defaults[0].tokens, '2.50M');
  assert.equal(defaults[39].id, uuid(100 + 180));
  const single = parseGoalRows(await harness.call('codex_goals', { limit: 1 }));
  assert.equal(single.length, 1);
  assert.equal(parseGoalRows(await harness.call('codex_goals', { limit: 0 })).length, 1);
  assert.equal(parseGoalRows(await harness.call('codex_goals', { limit: 1_000_000 })).length, 200);
  assert.equal(parseGoalRows(await harness.call('codex_goals', { limit: 2.5 })).length, 40);
  const blocked = parseGoalRows(await harness.call('codex_goals', { status: 'blocked', limit: 200 }));
  assert.equal(blocked.length, 10);
  assert.equal(blocked.every((row) => row.status === 'blocked'), true);
  assert.equal(parseGoalRows(await harness.call('codex_goals', { status: 'paused' })).length, 10);
  assert.match(await harness.call('codex_goals', { status: 'bogus' }), /^no Codex goal rows matched$/u);
  const byName = parseGoalRows(await harness.call('codex_goals', { thread: 'goalnamed' }));
  assert.equal(byName.length, 1);
  assert.equal(byName[0].id, uuid(100 + 219));
  const byId = parseGoalRows(await harness.call('codex_goals', { thread: uuid(100 + 100) }));
  assert.equal(byId.length, 1);
  assert.equal(byId[0].status, 'active');
  await assert.rejects(harness.call('codex_goals', { thread: 'no-such-thread' }), /unknown Codex thread "no-such-thread"/u);
});

test('A4 goal objective is collapsed and clipped to 110 characters', async (t) => {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const longObjective = 'alpha\n beta ' + 'z'.repeat(300);
  await addGoals(home, [{ threadId: uuid(300), status: 'active', tokensUsed: 999, updatedAtMs: 1_700_000_000_000, objective: longObjective }]);
  const harness = createHarness({ codexHome: home, executable: exe });
  const rows = parseGoalRows(await harness.call('codex_goals', {}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].objective, clipped('alpha beta ' + 'z'.repeat(300), 110));
  assert.equal(rows[0].tokens, '999');
  assert.match(rows[0].last, /d$/u);
});

test('A4 readGoals degrades gracefully when the database is absent, renamed, or malformed', async (t) => {
  const absent = makeHome(t);
  assert.deepEqual(await readGoals(absent), { available: false, rows: [], reason: 'no goals database found' });

  const renamed = makeHome(t);
  await addGoals(renamed, [{ threadId: uuid(400), status: 'active', tokensUsed: 10, updatedAtMs: 123 }], { filename: 'goals_2.sqlite' });
  const renamedResult = await readGoals(renamed);
  assert.equal(renamedResult.available, true);
  assert.deepEqual(renamedResult.rows, [
    { threadId: uuid(400), goalId: 'goal-' + uuid(400), objective: '', status: 'active', tokensUsed: 10, updatedAtMs: 123 },
  ]);

  const malformed = makeHome(t);
  await addGoals(malformed, [], { filename: 'goals_1.sqlite', schema: 'bad' });
  const malformedResult = await readGoals(malformed);
  assert.equal(malformedResult.available, false);
  assert.match(malformedResult.reason, /goal query failed on goals_1\.sqlite: .+/u);

  const harness = createHarness({ codexHome: absent, executable: addExecutable(absent) });
  assert.match(await harness.call('codex_goals', {}), /^goals unavailable: no goals database found$/u);
  const emptyDb = makeHome(t);
  await addGoals(emptyDb, []);
  const emptyHarness = createHarness({ codexHome: emptyDb, executable: addExecutable(emptyDb) });
  assert.match(await emptyHarness.call('codex_goals', {}), /^no Codex goal rows matched$/u);
});

/* ── A5: codex_liveness verdicts, idleMs clamp, nudge gate ────────────── */

async function buildLivenessHome(t) {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const now = Date.now();
  addIndex(home, [
    { id: uuid(50), name: 'runme', updatedAt: iso(now - 10_000) },
    { id: uuid(51), name: 'locky', updatedAt: iso(now) },
    { id: uuid(52), name: 'goalhot', updatedAt: iso(now - 60_000) },
    { id: uuid(53), name: 'goalcold', updatedAt: iso(now - 2 * 3_600_000) },
    { id: uuid(54), name: 'blocked', updatedAt: iso(now - 3 * 3_600_000) },
    { id: uuid(55), name: 'paused', updatedAt: iso(now - 4 * 3_600_000) },
    { id: uuid(56), name: 'autom', updatedAt: iso(now - 5 * 3_600_000) },
    { id: uuid(57), name: 'idle', updatedAt: iso(now - 2 * 86_400_000) },
  ]);
  for (const [index, age] of [
    [50, 10_000],
    [52, 120_000],
    [53, 2 * 3_600_000],
    [56, 5 * 3_600_000],
    [57, 2 * 86_400_000],
  ]) {
    addRollout(home, {
      id: uuid(index),
      rows: [metaRow(uuid(index)), userRow('message', now - age)],
      mtimeMs: now - age,
    });
  }
  addRollout(home, { id: uuid(51), rows: [metaRow(uuid(51)), userRow('locky', now - 120_000)], mtimeMs: now - 120_000 });
  addLock(home, uuid(51), now);
  addAutomation(home, { dirName: 'auto-autom', id: 'auto-autom', status: 'ACTIVE', targetThreadId: uuid(56) });
  await addGoals(home, [
    { threadId: uuid(52), status: 'active', tokensUsed: 10, updatedAtMs: now - 60_000, objective: 'hot' },
    { threadId: uuid(53), status: 'active', tokensUsed: 20, updatedAtMs: now - 2 * 3_600_000, objective: 'cold' },
    { threadId: uuid(54), status: 'blocked', tokensUsed: 30, updatedAtMs: now - 3 * 3_600_000, objective: 'blocked' },
    { threadId: uuid(55), status: 'paused', tokensUsed: 40, updatedAtMs: now - 4 * 3_600_000, objective: 'paused' },
  ]);
  return { home, exe, now };
}

test('A5 default set covers goal, automation, and configured threads with distinct verdicts', async (t) => {
  const { home, exe } = await buildLivenessHome(t);
  const harness = createHarness({ codexHome: home, executable: exe, liveness: { threads: ['idle', 'locky'] } });
  const live = parseLiveness(await harness.call('codex_liveness', {}));
  assert.match(live.header, /^liveness @ \S+ \(idle threshold 30m\)$/u);
  assert.equal(live.rows.length, 7);
  const names = new Set(live.rows.map((row) => row.label.split(' ')[0]));
  for (const name of ['locky', 'goalhot', 'goalcold', 'blocked', 'paused', 'autom', 'idle']) assert.equal(names.has(name), true, name);
  const verdictOf = (name) => live.rows.find((row) => row.label.startsWith(name + ' ')).verdict;
  assert.equal(verdictOf('locky'), 'working (writer lock fresh)');
  assert.equal(verdictOf('goalhot'), 'working (goal active)');
  assert.match(verdictOf('goalcold'), /^stalled: goal active, no write for 2\.0h$/u);
  assert.equal(verdictOf('blocked'), 'blocked goal (needs an authorized resume; not nudged)');
  assert.equal(verdictOf('paused'), 'paused goal (not nudged)');
  assert.match(verdictOf('autom'), /^automation thread \(idle 5\.0h\)$/u);
  assert.match(verdictOf('idle'), /^idle 2\.0d$/u);
  const sent = await harness.call('codex_send', { message: 'run', thread: 'runme' });
  assert.match(sent, /status: running/);
  const running = parseLiveness(await harness.call('codex_liveness', { threads: ['runme'] }));
  assert.match(running.rows[0].verdict, /^working \(bridge turn [0-9a-f-]{36}\)$/u);
  assert.equal(harness.spawns.length, 1);
  await assert.rejects(harness.call('codex_liveness', { threads: ['no-such-thread'] }), /unknown Codex thread "no-such-thread"/u);
});

test('A5 idleMs is clamped to 60s..24h and falls back to config', async (t) => {
  const { home, exe } = await buildLivenessHome(t);
  const harness = createHarness({ codexHome: home, executable: exe, liveness: { threads: ['idle'] } });
  const threshold = (text) => parseLiveness(text).header.match(/idle threshold (\S+)\)$/u)[1];
  assert.equal(threshold(await harness.call('codex_liveness', { idleMs: 1 })), '1m');
  assert.equal(threshold(await harness.call('codex_liveness', { idleMs: 59_999 })), '1m');
  assert.equal(threshold(await harness.call('codex_liveness', { idleMs: 1e15 })), '1.0d');
  assert.equal(threshold(await harness.call('codex_liveness', { idleMs: 86_400_001 })), '1.0d');
  assert.equal(threshold(await harness.call('codex_liveness', { idleMs: 0 })), '30m');
  assert.equal(threshold(await harness.call('codex_liveness', {})), '30m');
});

test('A5 nudge is refused when allowNudge is false and never fires for blocked or paused goals', async (t) => {
  const { home, exe } = await buildLivenessHome(t);
  const refused = createHarness({ codexHome: home, executable: exe, allowNudge: false, liveness: { threads: ['idle'] } });
  assert.match(
    await refused.call('codex_liveness', { nudge: true }),
    /^refused: nudge requested but config\.allowNudge is false \(set allowNudge: true in the plugin config to enable\)$/u,
  );
  assert.equal(refused.spawns.length, 0);
  assert.match(await refused.call('codex_liveness', { nudge: true, threads: ['goalcold'] }), /^refused: /u);
  assert.equal(refused.spawns.length, 0);

  const allowed = createHarness({ codexHome: home, executable: exe, allowNudge: true, nudgeWaitMs: 0, liveness: { threads: ['idle'] } });
  const text = await allowed.call('codex_liveness', { nudge: true, threads: ['goalcold', 'blocked', 'paused'] });
  assert.match(text, /nudged -> run [0-9a-f-]{36} \(running\)/u);
  assert.equal(allowed.spawns.length, 1);
  assert.equal(allowed.spawns[0].argv.includes(uuid(53)), true);
  assert.equal(allowed.spawns[0].argv.slice(0, 3).join(' '), [exe, 'exec', 'resume'].join(' '));
  const nudgedLines = text.split('\n').filter((line) => line.startsWith('  nudged -> run'));
  assert.equal(nudgedLines.length, 1);
  assert.equal(/blocked /u.test(nudgedLines[0]), false);
  assert.equal(/paused /u.test(nudgedLines[0]), false);

  const noNudge = createHarness({ codexHome: home, executable: exe, allowNudge: true, liveness: { threads: ['idle'] } });
  await noNudge.call('codex_liveness', { threads: ['goalcold'] });
  assert.equal(noNudge.spawns.length, 0);
});

test('A5 configured liveness threads match by id as well as by name', async (t) => {
  const { home, exe } = await buildLivenessHome(t);
  const idleId = uuid(57);
  const baseline = createHarness({ codexHome: home, executable: exe });
  const before = parseLiveness(await baseline.call('codex_liveness', {}));
  assert.equal(before.rows.some((row) => row.label.startsWith('idle ')), false);
  const byId = createHarness({ codexHome: home, executable: exe, liveness: { threads: [idleId] } });
  const fromId = parseLiveness(await byId.call('codex_liveness', {}));
  assert.equal(fromId.rows.some((row) => row.label === 'idle ' + idleId), true);
  const mixed = createHarness({ codexHome: home, executable: exe, liveness: { threads: [idleId, 'locky'] } });
  const both = parseLiveness(await mixed.call('codex_liveness', {}));
  assert.equal(both.rows.some((row) => row.label.startsWith('locky ')), true);
  assert.equal(both.rows.some((row) => row.label === 'idle ' + idleId), true);
});

/* ── A6: read-only guarantees ─────────────────────────────────────────── */

test('A6 static audit finds no filesystem write calls in the runtime sources', () => {
  const sources = ['index.js', path.join('lib', 'catalog.mjs'), path.join('lib', 'codex-home.mjs'), path.join('lib', 'rollout.mjs'), path.join('lib', 'util.mjs'), path.join('lib', 'runner.mjs')];
  const writePatterns = [
    /\.writeFileSync\s*\(/u,
    /\.writeFile\s*\(/u,
    /\.appendFile(Sync)?\s*\(/u,
    /\.createWriteStream\s*\(/u,
    /\.mkdir(Sync)?\s*\(/u,
    /\.rm(Sync)?\s*\(/u,
    /\.unlink(Sync)?\s*\(/u,
    /\.rename(Sync)?\s*\(/u,
    /\.copyFile(Sync)?\s*\(/u,
    /\.truncate(Sync)?\s*\(/u,
    /\.writeSync\s*\(/u,
    /\.chmod(Sync)?\s*\(/u,
    /\.utimes(Sync)?\s*\(/u,
  ];
  for (const relative of sources) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    for (const pattern of writePatterns) assert.doesNotMatch(source, pattern, relative + ' must not write files');
    assert.doesNotMatch(source, /node:child_process/u, relative + ' must not spawn child processes directly');
    assert.doesNotMatch(source, /process\.env\.[A-Za-z_$][\w$]*\s*=/u, relative + ' must not mutate process.env');
    for (const match of source.matchAll(/openSync\([^)]*\)/gu)) {
      assert.match(match[0], /['"]r['"]/u, relative + ' only opens files for reading: ' + match[0]);
    }
  }
  const codexHomeSource = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'codex-home.mjs'), 'utf8');
  assert.match(codexHomeSource, /new DatabaseSync\(file, \{ readOnly: true \}\)/u);
  assert.match(codexHomeSource, /import\('node:sqlite'\)/u);
  const runnerSource = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'runner.mjs'), 'utf8');
  assert.match(runnerSource, /ctx\.subprocess\.spawn\(/u);
});

function hashTree(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        entries.push({ relative, directory: true });
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      entries.push({
        relative,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
      });
    }
  };
  walk(root);
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

test('A6 the full read plane leaves the fixture CODEX_HOME byte-identical', async (t) => {
  const home = makeHome(t);
  const exe = addExecutable(home);
  const now = Date.now();
  addIndex(home, [
    { id: uuid(60), name: 'one', updatedAt: iso(now - 1000) },
    { id: uuid(61), name: 'two', updatedAt: iso(now - 2000) },
  ]);
  addRollout(home, { id: uuid(60), rows: [metaRow(uuid(60)), userRow('hello one', now - 2000), turnEndRow('done one', now - 1000)], mtimeMs: now - 1000 });
  addRollout(home, { id: uuid(61), rows: [metaRow(uuid(61)), userRow('hello two', now - 3000), turnEndRow('done two', now - 2000)], mtimeMs: now - 2000 });
  addLock(home, uuid(60), now - 500);
  addAutomation(home, { dirName: 'auto-one', id: 'auto-one', status: 'ACTIVE', targetThreadId: uuid(60) });
  await addGoals(home, [{ threadId: uuid(61), status: 'active', tokensUsed: 55, updatedAtMs: now - 2000, objective: 'read only' }]);

  const before = hashTree(home);
  const catalog = await buildCatalog(home);
  assert.ok(catalog.threads.length >= 2);
  const goals = await readGoals(home);
  assert.equal(goals.available, true);
  const harness = createHarness({ codexHome: home, executable: exe });
  await harness.call('codex_threads', {});
  await harness.call('codex_read', { thread: 'one' });
  await harness.call('codex_read', { thread: 'two', tailBytes: 65536 });
  await harness.call('codex_goals', {});
  await harness.call('codex_liveness', {});
  assert.equal(harness.spawns.length, 0, 'read tools must not spawn codex');
  assert.deepEqual(hashTree(home), before);
});

/* ── child-process probe for A1 environment-dependent resolution ─────── */

function writeProbe(t, root) {
  const probe = path.join(root, 'a1-probe.mjs');
  fs.writeFileSync(
    probe,
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const spec = JSON.parse(process.argv[2]);',
      'const out = {};',
      "if (spec.mode === 'resolve-home' || spec.mode === 'find-exe') {",
      '  const homeLib = await import(spec.modHome);',
      '  const saved = {};',
      "  for (const key of ['CODEX_HOME', 'CODEX_BIN', 'LOCALAPPDATA', 'PATH']) saved[key] = process.env[key];",
      '  const restore = () => { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } };',
      '  out.scenarios = [];',
      '  try {',
      '    for (const scenario of spec.scenarios) {',
      '      for (const removed of scenario.deletePaths ?? []) fs.rmSync(removed, { recursive: true, force: true });',
      "      if (spec.mode === 'resolve-home') {",
      '        if (scenario.envCodexHome === null || scenario.envCodexHome === undefined) delete process.env.CODEX_HOME;',
      '        else process.env.CODEX_HOME = scenario.envCodexHome;',
      "        process.env.CODEX_BIN = ''; process.env.LOCALAPPDATA = ''; process.env.PATH = '';",
      "        if (scenario.removeHomedirCodex) fs.rmSync(path.join(spec.fakeUserHome, '.codex'), { recursive: true, force: true });",
      '        out.scenarios.push({ name: scenario.name, result: homeLib.resolveCodexHome(scenario.configured ?? \'\') ?? null });',
      '        continue;',
      '      }',
      "      const env = scenario.env ?? {};",
      "      for (const key of ['CODEX_BIN', 'LOCALAPPDATA', 'PATH']) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }",
      '      const found = homeLib.findCodexExecutable(scenario.configured ?? \'\', scenario.home);',
      '      out.scenarios.push({ name: scenario.name, result: found ?? null });',
      '    }',
      '  } finally { restore(); }',
      '} else if (spec.mode === \'tools\') {',
      '  const index = await import(spec.modIndex);',
      '  const registry = new Map();',
      '  const context = {',
      '    effect(handler) { handler(); },',
      '    get() { return undefined; },',
      '    tools: { register(definition) { registry.set(definition.name, definition); return { dispose() {} }; } },',
      "    subprocess: { spawn() { return { collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '' }) } }, done: new Promise(() => {}) }; } },",
      '  };',
      '  index.apply(context, spec.config ?? {});',
      '  const call = async (name, args) => {',
      '    try { const value = await registry.get(name).execute(args, {}); return { ok: true, text: value.text }; }',
      '    catch (error) { return { ok: false, error: String(error?.message ?? error) }; }',
      '  };',
      '  out.tools = {',
      "    threads: await call('codex_threads', {}),",
      "    read: await call('codex_read', { thread: spec.readThread ?? 'probe' }),",
      "    goals: await call('codex_goals', {}),",
      "    liveness: await call('codex_liveness', {}),",
      "    send: await call('codex_send', { message: 'probe' }),",
      '  };',
      '}',
      'console.log(JSON.stringify(out));',
    ].join('\n'),
  );
  return probe;
}

function runProbe(t, probe, payload) {
  const env = {
    ...process.env,
    USERPROFILE: payload.fakeUserHome,
    HOME: payload.fakeUserHome,
    CODEX_HOME: '',
    CODEX_BIN: '',
    LOCALAPPDATA: '',
    PATH: '',
    ...(payload.env ?? {}),
  };
  const result = spawnSync(process.execPath, [probe, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, 'probe failed: ' + String(result.stderr));
  const lines = String(result.stdout).trim().split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1));
}
