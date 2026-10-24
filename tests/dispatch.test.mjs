/**
 * Offline verification of the codex-bridge dispatch plane (verification matrix B1-B7).
 *
 * Method: FIX. The real plugin (apply from index.js) runs against a temporary CODEX_HOME
 * fixture and a fake subprocess seam; a fake codex executable (Node script) emits the
 * codex exec JSONL protocol. No network access, no model turn, no real CODEX_HOME.
 *
 * Run: node --test tests/dispatch.test.mjs
 * Optional raw evidence: DISPATCH_EVIDENCE_DIR=<dir> node --test tests/dispatch.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  FAKE_CODEX,
  FIXED_NUDGE_MESSAGE,
  FIXED_THREAD_ID,
  makeHarness,
  readCapture,
  waitFor,
} from './support/harness.mjs';
import { record } from './support/evidence.mjs';

// Credential markers that must never reach the child environment.
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
process.env.GITHUB_TOKEN = 'ghp_test_not_a_real_token';
process.env.CODEX_API_KEY = 'codex-test-not-a-real-key';
process.env.AWS_SECRET_ACCESS_KEY = 'aws-test-not-a-real-key';

const CREDENTIAL_NAMES = ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'CODEX_API_KEY', 'AWS_SECRET_ACCESS_KEY'];
const TWO_HOURS = 2 * 3_600_000;

function runIdOf(text) {
  const match = text.match(/^run: (\S+)$/mu);
  assert.ok(match, 'expected a "run: <id>" line in output:\n' + text);
  return match[1];
}

function listRows(text) {
  return text.split('\n').slice(1).filter((line) => line !== '');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertNoCredentials(env, label) {
  for (const name of CREDENTIAL_NAMES) {
    assert.equal(Object.hasOwn(env, name), false, name + ' must not reach the child env (' + label + ')');
  }
}

/* ── B1: new-thread argv / stdin / env ─────────────────────────────────────── */

test('B1 new thread: argv, stdin bytes, CODEX_HOME and credential-free env', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, { capture: true });
  const prompt = '第一行: 你好世界 🚀\n第二行: café naïve\n\tindented line\n第三行: end';
  const text = await bridge.call('codex_send', {
    message: prompt,
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });

  assert.match(text, /^run: [0-9a-f-]{36}$/mu);
  assert.match(text, /^status: completed after /mu);
  assert.ok(text.includes('thread: ' + FIXED_THREAD_ID), 'thread id line missing:\n' + text);
  assert.ok(text.includes('fake codex completed'));

  assert.equal(seam.calls.length, 1);
  const spawn = seam.calls[0];
  assert.deepEqual(spawn.argv, [
    FAKE_CODEX,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    fixture.workspaces.main,
    '-c',
    'approval_policy=never',
    '-',
  ]);
  assert.equal(spawn.cwd, fixture.workspaces.main);
  assert.equal(spawn.stdio.stdin.data, prompt);
  assert.equal(spawn.stdio.stdout.maxBytes, 1_048_576);
  assert.deepEqual(spawn.stdio.stdout.spill, { maxBytes: 8_388_608 });
  assert.equal(spawn.stdio.stderr.maxBytes, 65_536);
  assert.equal(spawn.graceMs, 5_000);
  assert.equal(spawn.env.CODEX_HOME, fixture.home);
  assert.equal(spawn.env.NO_COLOR, '1');
  assert.equal(spawn.env.TERM, 'dumb');
  assert.equal(typeof spawn.env.PATH, 'string');
  assert.equal(spawn.env.FAKE_CODEX_MODE, 'normal');
  assertNoCredentials(spawn.env, 'fake seam spawn spec');

  // The fake executable's own capture proves the bytes/env the OS actually delivered.
  const capture = await readCapture(fixture);
  assert.equal(capture.cwd, fixture.workspaces.main);
  assert.deepEqual(capture.argv, spawn.argv.slice(1));
  const stdinBytes = Buffer.from(capture.stdinB64, 'base64');
  assert.equal(stdinBytes.toString('utf8'), prompt);
  assert.equal(capture.stdinLen, Buffer.byteLength(prompt, 'utf8'));
  assert.equal(capture.stdinSha256, sha256(prompt));
  assert.equal(capture.env.CODEX_HOME, fixture.home);
  assertNoCredentials(capture.env, 'fake codex child env');

  record('B1-new-thread', {
    argv: spawn.argv,
    cwd: spawn.cwd,
    stdio: {
      stdinBytes: capture.stdinLen,
      stdoutMaxBytes: spawn.stdio.stdout.maxBytes,
      stdoutSpill: spawn.stdio.stdout.spill,
      stderrMaxBytes: spawn.stdio.stderr.maxBytes,
    },
    graceMs: spawn.graceMs,
    envKeys: Object.keys(spawn.env).sort(),
    credentialsPresent: [],
    stdinSha256: capture.stdinSha256,
    promptChars: prompt.length,
    threadId: FIXED_THREAD_ID,
    toolOutput: text,
  });
});

test('B1 cwd defaulting and argv overrides', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  const first = await bridge.call('codex_send', { message: 'default cwd probe', waitMs: 5_000 });
  assert.match(first, /^status: completed after /mu);
  assert.equal(seam.calls[0].cwd, fixture.workspaces.main);
  assert.deepEqual(seam.calls[0].argv, [
    FAKE_CODEX,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    fixture.workspaces.main,
    '-c',
    'approval_policy=never',
    '-',
  ]);

  const override = fixture.workspace('override-workspace');
  const second = await bridge.call('codex_send', {
    message: 'override probe',
    cwd: override,
    waitMs: 5_000,
    model: 'gpt-5-codex',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
  });
  assert.match(second, /^status: completed after /mu);
  assert.deepEqual(seam.calls[1].argv, [
    FAKE_CODEX,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    override,
    '-m',
    'gpt-5-codex',
    '-c',
    'approval_policy=on-request',
    '-c',
    'sandbox_mode=workspace-write',
    '-',
  ]);
  record('B1-cwd-overrides', { defaultCwdArgv: seam.calls[0].argv, overrideArgv: seam.calls[1].argv });
});

test('B1 prompt fidelity: the prompt reaches stdin byte-for-byte, edge whitespace included', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  const padded = '\n\n  padded prompt line\nsecond line  \n';
  await bridge.call('codex_send', { message: padded, cwd: fixture.workspaces.main, waitMs: 5_000 });
  const delivered = seam.calls[0].stdio.stdin.data;
  assert.equal(delivered, padded);
  record('B1-prompt-fidelity', {
    input: padded,
    stdin: delivered,
    note: 'index.js only trims to test for emptiness; the original message reaches stdin unchanged',
  });
});

test('B1 blank prompts are rejected before any spawn', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  await assert.rejects(
    bridge.call('codex_send', { message: '   \n\t ', cwd: fixture.workspaces.main }),
    /message must be a non-empty string/u,
  );
  assert.equal(seam.calls.length, 0);
});

/* ── B2: async dispatch and polling ───────────────────────────────────────── */

test('B2 async dispatch: waitMs=0 returns running, codex_run lists and polls to completed', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_DELAY_MS: '500', FAKE_CODEX_FINAL_MESSAGE: 'async final' },
  });
  const startedAt = Date.now();
  const text = await bridge.call('codex_send', {
    message: 'async task',
    cwd: fixture.workspaces.main,
    waitMs: 0,
  });
  const elapsed = Date.now() - startedAt;
  assert.match(text, /^status: running \(waited 0ms; poll codex_run with runId\)$/mu);
  const runId = runIdOf(text);
  assert.ok(elapsed < 400, 'waitMs=0 must not wait for the child (elapsed ' + elapsed + 'ms)');

  const list = await bridge.call('codex_run', {});
  assert.match(list, /^bridge runs \(newest first\):$/mu);
  assert.ok(list.includes(runId));
  assert.match(list, /\(new\)/u);
  assert.match(list, /async task/u);

  const running = await bridge.call('codex_run', { runId });
  assert.match(running, /^status: running$/mu);
  assert.match(running, /^target: \(new\)$/mu);
  assert.match(running, /^final message:\n\(none yet\)$/mu);

  const completed = await waitFor(
    async () => {
      const detail = await bridge.call('codex_run', { runId });
      return /^status: completed$/mu.test(detail) ? detail : undefined;
    },
    { label: 'run completion' },
  );
  assert.ok(completed.includes('target: (new) -> ' + FIXED_THREAD_ID), completed);
  assert.match(completed, /^usage: 12$/mu);
  assert.match(completed, /^final message:\nasync final$/mu);
  assert.equal(seam.calls.length, 1);
  record('B2-async-polling', { runId, elapsedMs: elapsed, list, running, completed });
});

test('B2 waitMs>0 blocks until the child settles', async (t) => {
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_DELAY_MS: '100', FAKE_CODEX_FINAL_MESSAGE: 'blocking final', FAKE_CODEX_TOTAL_TOKENS: '1500' },
  });
  const startedAt = Date.now();
  const text = await bridge.call('codex_send', {
    message: 'blocking task',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.match(text, /^status: completed after /mu);
  assert.match(text, /^final message:\nblocking final$/mu);
  assert.ok(elapsed >= 80, 'waitMs>0 should wait for the child (elapsed ' + elapsed + 'ms)');
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: completed$/mu);
  assert.match(detail, /^usage: 1\.5k$/mu);
  record('B2-blocking-wait', { elapsedMs: elapsed, toolOutput: text, detail });
});

test('B2 maxWaitMs caps the blocking wait', async (t) => {
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_DELAY_MS: '2500' },
    config: { maxWaitMs: 1_000 },
  });
  const startedAt = Date.now();
  const text = await bridge.call('codex_send', {
    message: 'slow task',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.match(text, /^status: running \(waited 5000ms; poll codex_run with runId\)$/mu);
  assert.ok(elapsed >= 950, 'maxWaitMs=1000 should wait about 1000ms (elapsed ' + elapsed + 'ms)');
  assert.ok(elapsed < 2300, 'maxWaitMs=1000 must cap the 5000ms request (elapsed ' + elapsed + 'ms)');
  record('B2-max-wait-cap', { elapsedMs: elapsed, toolOutput: text, configMaxWaitMs: 1_000 });
});

test('B2 codex_run with no runs reports an empty Host session', async (t) => {
  const { bridge } = await makeHarness(t);
  assert.equal(await bridge.call('codex_run', {}), 'no bridge runs in this Host session yet');
});

/* ── B3: resume ───────────────────────────────────────────────────────────── */

function addResearcher(fixture, options = {}) {
  const cwd = options.cwd ?? fixture.workspace('thread-workspace');
  return fixture.addThread({
    name: options.name ?? 'fixture-researcher',
    cwd,
    ageMs: options.ageMs ?? 5 * 60_000,
  });
}

test('B3 resume: argv, rollout-meta cwd, name/prefix/@name resolution, cwd override', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, { capture: true });
  const thread = addResearcher(fixture);

  const first = await bridge.call('codex_send', {
    thread: 'fixture-researcher',
    message: 'continue the research',
    waitMs: 5_000,
  });
  assert.match(first, /^status: completed after /mu);
  assert.ok(first.includes('target: fixture-researcher ' + thread.id));
  assert.ok(first.includes('thread: ' + thread.id));
  assert.equal(seam.calls.length, 1);
  const spawn = seam.calls[0];
  assert.deepEqual(spawn.argv, [
    FAKE_CODEX,
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'approval_policy=never',
    thread.id,
    '-',
  ]);
  assert.equal(spawn.cwd, thread.cwd, 'resume cwd defaults to the thread rollout meta cwd');
  assert.equal(spawn.argv.includes('-C'), false, 'resume argv must not carry -C');
  assert.equal(spawn.stdio.stdin.data, 'continue the research');

  const capture = await readCapture(fixture);
  assert.deepEqual(capture.argv, spawn.argv.slice(1));
  assert.equal(capture.cwd, thread.cwd);
  assert.equal(capture.stdinSha256, sha256('continue the research'));

  // Thread references: id prefix and @name resolve to the same thread id.
  await bridge.call('codex_send', { thread: thread.id.slice(0, 8), message: 'by id prefix', waitMs: 5_000 });
  await bridge.call('codex_send', { thread: '@fixture-researcher', message: 'by at name', waitMs: 5_000 });
  assert.equal(seam.calls.length, 3);
  assert.equal(seam.calls[1].argv.at(-2), thread.id);
  assert.equal(seam.calls[2].argv.at(-2), thread.id);

  // Explicit cwd overrides the rollout cwd but is not turned into -C.
  const override = fixture.workspace('resume-override');
  await bridge.call('codex_send', {
    thread: 'fixture-researcher',
    message: 'cwd override',
    cwd: override,
    waitMs: 5_000,
  });
  assert.equal(seam.calls[3].cwd, override);
  assert.equal(seam.calls[3].argv.includes('-C'), false);
  record('B3-resume', {
    threadId: thread.id,
    resumeArgv: spawn.argv,
    rolloutCwd: thread.cwd,
    resolvedPrefixAndName: true,
    cwdOverride: override,
  });
});

test('B3 single writer: a running bridge turn refuses a second dispatch without spawning', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, { env: { FAKE_CODEX_DELAY_MS: '800' } });
  const thread = addResearcher(fixture);
  const first = await bridge.call('codex_send', { thread: thread.name, message: 'writer one', waitMs: 0 });
  assert.match(first, /^status: running /mu);
  const firstRunId = runIdOf(first);
  const second = await bridge.call('codex_send', { thread: thread.name, message: 'writer two', waitMs: 5_000 });
  const expected =
    'refused: thread fixture-researcher ' +
    thread.id +
    ' already has a running bridge turn (' +
    firstRunId +
    '); poll codex_run instead of starting a second writer';
  assert.ok(second.startsWith(expected), 'unexpected refusal text:\n' + second);
  assert.equal(seam.calls.length, 1, 'the second writer must not spawn a child');
  record('B3-single-writer', { threadId: thread.id, firstRunId, refusal: second, spawnCount: seam.calls.length });
});

test('B3 external writer refusal is surfaced as a failed run with a stderr tail', async (t) => {
  const stderr = 'fixture codex: thread is already being written by another process (writer lock held)\n';
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_MODE: 'fail', FAKE_CODEX_STDERR: stderr, FAKE_CODEX_EXIT_CODE: '1' },
  });
  const thread = addResearcher(fixture);
  const text = await bridge.call('codex_send', { thread: thread.name, message: 'external conflict', waitMs: 5_000 });
  assert.match(text, /^status: failed after /mu);
  assert.match(text, /^stderr tail:$/mu);
  assert.ok(text.includes('already being written by another process'));
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: failed$/mu);
  assert.ok(detail.includes('already being written by another process'));
  record('B3-external-writer-refusal', { toolOutput: text, detail });
});

/* ── B4: failure paths ────────────────────────────────────────────────────── */

test('B4 non-zero exit fails the run and exposes the stderr tail', async (t) => {
  const stderr = 'fatal: simulated Codex failure: model unavailable\n';
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_MODE: 'fail', FAKE_CODEX_STDERR: stderr, FAKE_CODEX_EXIT_CODE: '3' },
  });
  const text = await bridge.call('codex_send', {
    message: 'failure probe',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  assert.match(text, /^status: failed after /mu);
  assert.match(text, /^stderr tail:$/mu);
  assert.ok(text.includes('fatal: simulated Codex failure: model unavailable'));
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: failed$/mu);
  assert.ok(detail.includes('fatal: simulated Codex failure: model unavailable'));
  record('B4-nonzero-exit', { exitCode: 3, toolOutput: text, detail });
});

test('B4 protocol error event fails the run with the reported message', async (t) => {
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_MODE: 'error-event', FAKE_CODEX_ERROR: 'model overloaded (429)' },
  });
  const text = await bridge.call('codex_send', {
    message: 'protocol error probe',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  assert.match(text, /^status: failed after /mu);
  assert.match(text, /^error: model overloaded \(429\)$/mu);
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: failed$/mu);
  assert.match(detail, /^error: model overloaded \(429\)$/mu);
  record('B4-protocol-error', { toolOutput: text, detail });
});

test('B4 turn.failed event fails the run with error.message', async (t) => {
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_MODE: 'turn-failed', FAKE_CODEX_ERROR: 'turn failed fixture' },
  });
  const text = await bridge.call('codex_send', {
    message: 'turn failed probe',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  assert.match(text, /^status: failed after /mu);
  assert.match(text, /^error: turn failed fixture$/mu);
  record('B4-turn-failed', { toolOutput: text });
});

test('B4 synchronous seam spawn failure rejects codex_send', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  seam.spawnError = new Error('fixture seam exploded before spawn');
  await assert.rejects(
    bridge.call('codex_send', { message: 'spawn failure', cwd: fixture.workspaces.main, waitMs: 5_000 }),
    /fixture seam exploded before spawn/u,
  );
  assert.equal(await bridge.call('codex_run', {}), 'no bridge runs in this Host session yet');
  record('B4-spawn-throw', { error: 'fixture seam exploded before spawn' });
});

test('B4 asynchronous seam launch failure marks the run failed', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  seam.doneError = new Error('subprocess failed before reporting an outcome: fixture EACCES');
  const text = await bridge.call('codex_send', {
    message: 'async spawn failure',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  assert.match(text, /^status: failed after /mu);
  assert.ok(text.includes('subprocess failed before reporting an outcome: fixture EACCES'));
  assert.match(text, /^error: subprocess failed before reporting an outcome: fixture EACCES$/mu);
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: failed$/mu);
  assert.ok(detail.includes('fixture EACCES'));
  record('B4-done-reject', { toolOutput: text, detail });
});

test('B4 invalid arguments: unknown thread, unknown run id, non-string message', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    setup: (local) => {
      local.addThread({ name: 'known-thread', cwd: local.workspaces.main });
    },
  });
  await assert.rejects(
    bridge.call('codex_send', { thread: 'missing-thread', message: 'x', waitMs: 5_000 }),
    /unknown Codex thread "missing-thread"; named threads: known-thread/u,
  );
  await assert.rejects(bridge.call('codex_run', { runId: 'no-such-run' }), /unknown run id "no-such-run"/u);
  await assert.rejects(bridge.call('codex_send', { message: 42 }), /message must be a non-empty string/u);
  assert.equal(seam.calls.length, 0);
  record('B4-invalid-args', { spawnCount: seam.calls.length });
});

test('B4 unknown thread in codex_liveness threads filter is rejected', async (t) => {
  const { fixture, bridge } = await makeHarness(t);
  void fixture;
  await assert.rejects(
    bridge.call('codex_liveness', { threads: ['no-such-thread'], nudge: false, idleMs: 60_000 }),
    /unknown Codex thread "no-such-thread"/u,
  );
});

/* ── B5: codex_run semantics ──────────────────────────────────────────────── */

test('B5 codex_run: target labels, prompt preview, usage', async (t) => {
  const { fixture, bridge } = await makeHarness(t, { env: { FAKE_CODEX_TOTAL_TOKENS: '1500' } });
  const thread = fixture.addThread({ name: 'fixture-target', cwd: fixture.workspace('target-workspace') });
  const newText = await bridge.call('codex_send', {
    message: 'new thread probe '.repeat(20),
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  const newId = runIdOf(newText);
  const resumeText = await bridge.call('codex_send', {
    thread: 'fixture-target',
    message: 'resume probe',
    waitMs: 5_000,
  });
  const resumeId = runIdOf(resumeText);

  const list = await bridge.call('codex_run', {});
  assert.match(list, /^bridge runs \(newest first\):$/mu);
  const rows = listRows(list);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith(resumeId + '  completed ' + thread.id), 'resume row target: ' + rows[0]);
  assert.ok(rows[0].endsWith('resume probe'));
  assert.ok(rows[1].startsWith(newId + '  completed (new)'), 'new-thread row target: ' + rows[1]);
  const marker = ' ago  ';
  const preview = rows[1].slice(rows[1].indexOf(marker) + marker.length);
  assert.equal(preview.length, 61);
  assert.ok(preview.startsWith('new thread probe new thread probe'));
  assert.ok(preview.endsWith('…'));

  const detail = await bridge.call('codex_run', { runId: resumeId });
  assert.match(detail, /^usage: 1\.5k$/mu);
  assert.match(detail, /^final message:\nfake codex completed$/mu);
  record('B5-run-semantics', { list, resumeDetail: detail, newRunId: newId, resumeRunId: resumeId });
});

test('B5 usage falls back to input+output tokens when the CLI omits total_tokens', async (t) => {
  const { fixture, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_OMIT_TOTAL_TOKENS: '1', FAKE_CODEX_INPUT_TOKENS: '17457', FAKE_CODEX_OUTPUT_TOKENS: '9' },
  });
  const text = await bridge.call('codex_send', { message: 'usage fallback probe', cwd: fixture.workspaces.main, waitMs: 5_000 });
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^usage: 17\.5k$/mu);
  record('B5-usage-fallback', { detail });
});

test('B5 codex_run list: limit clamps to 1..30', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  const runIds = [];
  for (let index = 0; index < 31; index += 1) {
    const text = await bridge.call('codex_send', {
      message: 'bulk-' + index,
      cwd: fixture.workspaces.main,
      waitMs: 0,
    });
    runIds.push(runIdOf(text));
  }
  const defaults = await bridge.call('codex_run', {});
  assert.equal(listRows(defaults).length, 8);
  const clampedHigh = await bridge.call('codex_run', { limit: 100 });
  assert.equal(listRows(clampedHigh).length, 30);
  const clampedLow = await bridge.call('codex_run', { limit: 0 });
  assert.equal(listRows(clampedLow).length, 1);
  const fractional = await bridge.call('codex_run', { limit: 2.5 });
  assert.equal(listRows(fractional).length, 8);
  for (const id of runIds) assert.equal(id.length, 36);
  assert.equal(seam.calls.length, 31);
  const listed = new Set(listRows(clampedHigh).map((row) => row.split('  ')[0]));
  for (const id of listed) assert.ok(runIds.includes(id), 'listed id must belong to this test: ' + id);
  record('B5-list-limits', {
    runs: 31,
    defaultRows: listRows(defaults).length,
    maxRows: listRows(clampedHigh).length,
    minRows: listRows(clampedLow).length,
    fractionalRows: listRows(fractional).length,
  });
});

test('B5 final message is clipped to 6000 characters in codex_run', async (t) => {
  const { fixture, bridge } = await makeHarness(t, { env: { FAKE_CODEX_FINAL_REPEAT_LEN: '6500' } });
  const text = await bridge.call('codex_send', {
    message: 'clip probe',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  const message = detail.split('final message:\n')[1] ?? '';
  assert.equal(message.length, 6_001);
  assert.ok(message.startsWith('x'.repeat(6_000)));
  assert.ok(message.endsWith('…'));
  record('B5-final-message-clip', { finalMessageChars: message.length, tail: message.slice(-10) });
});

test('B5 oversized stdout is reported as lossy and spilled by the seam', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    env: {
      FAKE_CODEX_MODE: 'huge',
      FAKE_CODEX_NOISE_BYTES: '200000',
      FAKE_CODEX_FINAL_MESSAGE: 'survived the tail window',
    },
    config: { maxOutputBytes: 4_096 },
  });
  const text = await bridge.call('codex_send', {
    message: 'huge output probe',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  assert.match(text, /^status: completed after /mu);
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: completed$/mu);
  assert.match(detail, /\(stdout window truncated; full stream spilled on disk\)/u);
  assert.match(detail, /^final message:\nsurvived the tail window$/mu);
  assert.equal(seam.spills.length, 1);
  assert.ok(fs.existsSync(seam.spills[0].path));
  assert.ok(fs.statSync(seam.spills[0].path).size > 4_096);
  record('B5-stdout-lossy', {
    toolOutput: text,
    detail,
    spill: seam.spills[0],
    maxOutputBytes: 4_096,
  });
});

/* ── B6: dispose / termination ───────────────────────────────────────────── */

test('B6 dispose terminates a running child and blocks new dispatches', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    env: (local) => ({ FAKE_CODEX_MODE: 'hang', FAKE_CODEX_STARTED: local.startedMarker }),
  });
  const text = await bridge.call('codex_send', {
    message: 'hanging task',
    cwd: fixture.workspaces.main,
    waitMs: 0,
  });
  const runId = runIdOf(text);
  await waitFor(() => fs.existsSync(fixture.startedMarker), { label: 'fake codex start marker' });
  assert.equal(seam.handles.length, 1);
  bridge.dispose();
  await waitFor(() => seam.handles[0].exitInfo !== undefined, { label: 'child exit after dispose' });
  assert.equal(seam.handles[0].terminateCalls, 1);

  const detail = await bridge.call('codex_run', { runId });
  assert.match(detail, /^status: failed$/mu);
  assert.ok(detail.includes('codex exited without a message'));
  await assert.rejects(
    bridge.call('codex_send', { message: 'after dispose', cwd: fixture.workspaces.main, waitMs: 0 }),
    /codex bridge is shutting down/u,
  );
  record('B6-dispose', {
    runId,
    terminateCalls: seam.handles[0].terminateCalls,
    exitInfo: seam.handles[0].exitInfo,
    detail,
  });
});

test('B6 dispose leaves completed runs untouched', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, { env: { FAKE_CODEX_FINAL_MESSAGE: 'already done' } });
  const text = await bridge.call('codex_send', {
    message: 'complete then dispose',
    cwd: fixture.workspaces.main,
    waitMs: 5_000,
  });
  await waitFor(() => seam.handles[0].exitInfo !== undefined, { label: 'child exit' });
  bridge.dispose();
  assert.equal(seam.handles[0].terminateCalls, 0);
  const detail = await bridge.call('codex_run', { runId: runIdOf(text) });
  assert.match(detail, /^status: completed$/mu);
  assert.match(detail, /^final message:\nalready done$/mu);
  record('B6-dispose-completed', { terminateCalls: seam.handles[0].terminateCalls, detail });
});

/* ── B7: liveness nudge path ─────────────────────────────────────────────── */

function addStalledGoalThread(fixture, status = 'active', name = 'stalled-goal-thread') {
  const thread = fixture.addThread({ name, cwd: fixture.workspaces.main, ageMs: TWO_HOURS });
  fixture.addGoal({
    threadId: thread.id,
    status,
    objective: 'fixture goal for liveness verification',
    ageMs: TWO_HOURS,
  });
  return thread;
}

test('B7 nudge: allowNudge=true sends exactly one fixed continuation message', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    capture: true,
    config: { allowNudge: true, nudgeWaitMs: 5_000 },
    setup: (local) => {
      local.stalledThread = addStalledGoalThread(local, 'active');
    },
  });
  const text = await bridge.call('codex_liveness', { nudge: true });
  assert.match(text, /^liveness @ /mu);
  assert.ok(text.includes('stalled: goal active, no write for'));
  const nudgeLines = text.split('\n').filter((line) => line.includes('nudged -> run'));
  assert.equal(nudgeLines.length, 1, 'exactly one nudge line expected:\n' + text);
  assert.match(nudgeLines[0], /nudged -> run [0-9a-f-]{36} \(completed\)/u);

  assert.equal(seam.calls.length, 1);
  const spawn = seam.calls[0];
  assert.deepEqual(spawn.argv, [
    FAKE_CODEX,
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'approval_policy=never',
    fixture.stalledThread.id,
    '-',
  ]);
  assert.equal(spawn.cwd, fixture.workspaces.main);
  assert.equal(spawn.stdio.stdin.data, FIXED_NUDGE_MESSAGE);

  const capture = await readCapture(fixture);
  assert.equal(Buffer.from(capture.stdinB64, 'base64').toString('utf8'), FIXED_NUDGE_MESSAGE);
  assert.equal(capture.stdinSha256, sha256(FIXED_NUDGE_MESSAGE));
  record('B7-nudge-allowed', {
    threadId: fixture.stalledThread.id,
    nudgeLine: nudgeLines[0],
    argv: spawn.argv,
    stdinSha256: capture.stdinSha256,
    toolOutput: text,
  });
});

test('B7 nudge: allowNudge=false is refused explicitly without spawning', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    config: { allowNudge: false },
    setup: (local) => {
      addStalledGoalThread(local, 'active');
    },
  });
  const text = await bridge.call('codex_liveness', { nudge: true });
  assert.equal(
    text,
    'refused: nudge requested but config.allowNudge is false (set allowNudge: true in the plugin config to enable)',
  );
  assert.equal(seam.calls.length, 0);
  record('B7-nudge-refused', { toolOutput: text, spawnCount: seam.calls.length });
});

test('B7 blocked and paused goals are never nudged', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    config: { allowNudge: true, nudgeWaitMs: 5_000 },
    setup: (local) => {
      addStalledGoalThread(local, 'blocked', 'blocked-goal-thread');
      addStalledGoalThread(local, 'paused', 'paused-goal-thread');
    },
  });
  const text = await bridge.call('codex_liveness', { nudge: true });
  assert.ok(text.includes('blocked goal (needs an authorized resume; not nudged)'), text);
  assert.ok(text.includes('paused goal (not nudged)'), text);
  assert.equal(text.includes('nudged -> run'), false);
  assert.equal(seam.calls.length, 0);
  record('B7-nudge-blocked-paused', { toolOutput: text, spawnCount: seam.calls.length });
});

test('B7 nudge dispatch failure is caught as "nudge failed"', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    config: { allowNudge: true, nudgeWaitMs: 5_000 },
    setup: (local) => {
      addStalledGoalThread(local, 'active');
    },
  });
  bridge.dispose(); // runs are disposed: runs.start() now throws
  const text = await bridge.call('codex_liveness', { nudge: true });
  assert.ok(/nudge failed: codex bridge is shutting down/u.test(text), text);
  assert.equal(text.includes('nudged -> run'), false);
  assert.equal(seam.calls.length, 0);
  record('B7-nudge-failure-caught', { toolOutput: text, spawnCount: seam.calls.length });
});

test('B7 nudge turn failure is reported as nudged+failed, not nudge failed', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_MODE: 'fail', FAKE_CODEX_STDERR: 'nudge turn failed fixture\n', FAKE_CODEX_EXIT_CODE: '1' },
    config: { allowNudge: true, nudgeWaitMs: 5_000 },
    setup: (local) => {
      addStalledGoalThread(local, 'active');
    },
  });
  const text = await bridge.call('codex_liveness', { nudge: true });
  const nudgeLines = text.split('\n').filter((line) => line.includes('nudged -> run'));
  assert.equal(nudgeLines.length, 1);
  assert.match(nudgeLines[0], /nudged -> run [0-9a-f-]{36} \(failed\)/u);
  assert.equal(text.includes('nudge failed:'), false);
  assert.equal(seam.calls.length, 1);
  record('B7-nudge-turn-failure', {
    nudgeLine: nudgeLines[0],
    toolOutput: text,
    note: 'A dispatched-but-failed turn is reported as nudged+failed; only dispatch exceptions produce "nudge failed: ..."',
  });
});

test('B7 a thread with a running bridge turn is reported as working and not nudged', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t, {
    env: { FAKE_CODEX_DELAY_MS: '800' },
    config: { allowNudge: true, nudgeWaitMs: 5_000 },
    setup: (local) => {
      local.stalledThread = addStalledGoalThread(local, 'active');
    },
  });
  const started = await bridge.call('codex_send', { thread: fixture.stalledThread.name, message: 'busy', waitMs: 0 });
  assert.match(started, /^status: running /mu);
  const text = await bridge.call('codex_liveness', { nudge: true });
  assert.ok(text.includes('working (bridge turn '), text);
  assert.equal(text.includes('nudged -> run'), false);
  assert.equal(seam.calls.length, 1, 'the running turn must not be doubled by a nudge');
  record('B7-nudge-running-thread', { toolOutput: text, spawnCount: seam.calls.length });
});

/* ── CODE: static contract checks referenced by B1/B3 ─────────────────────── */

function pluginSource(relativePath) {
  return fs.readFileSync(new URL('../' + relativePath, import.meta.url), 'utf8');
}

test('CODE B1: runner forwards an explicit env whitelist, never process.env wholesale', () => {
  const source = pluginSource('lib/runner.mjs');
  assert.equal(/\.\.\.\s*process\.env/u.test(source), false, 'runner must not spread process.env');
  const start = source.indexOf('const ENV_KEYS');
  const end = source.indexOf('];', start);
  const whitelist = source.slice(start, end);
  const body = whitelist.slice(whitelist.indexOf('[') + 1);
  assert.ok(body.includes("'PATH'"));
  assert.equal(/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/u.test(body), false, 'credential-shaped names must not be whitelisted');
  assert.match(source, /env\.CODEX_HOME = home/u);
  record('CODE-B1-env-whitelist', {
    whitelistLines: whitelist.split('\n').filter((line) => line.includes("'")).length,
    spreadsProcessEnv: false,
    credentialNamesWhitelisted: false,
  });
});

test('CODE B3: buildArgv templates keep the documented new/resume shapes', () => {
  const source = pluginSource('lib/runner.mjs');
  assert.ok(
    source.includes("return [executable, 'exec', 'resume', '--json', '--skip-git-repo-check', ...common, threadId, '-']"),
    'resume argv template changed',
  );
  assert.ok(
    source.includes("[executable, 'exec', '--json', '--skip-git-repo-check', '-C', resolveWorkdir(cwd), ...common, '-']"),
    'new-thread argv template changed',
  );
  const hostSource = pluginSource('index.js');
  assert.ok(hostSource.includes('const active = runs.runningFor(thread.id);'), 'single-writer guard missing in index.js');
  assert.ok(hostSource.includes('refused: thread ${label} already has a running bridge turn'), 'single-writer refusal message missing');
  record('CODE-B3-argv-templates', { resumeShape: 'exec resume --json --skip-git-repo-check ... <threadId> -', newShape: 'exec --json --skip-git-repo-check -C <cwd> ... -' });
});
