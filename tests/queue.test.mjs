/**
 * Offline verification of the queue dispatch plane (codex_queue, v0.2.0).
 *
 * The official `codex queue` channel is how a bridge delivers a message into a
 * thread whose writer is owned by another process (usually the Codex desktop
 * app). These tests use the same fixture CODEX_HOME + fake subprocess seam as
 * tests/dispatch.test.mjs, plus a fake `queue` subcommand that can simulate the
 * owning writer delivering and completing a turn.
 *
 * Run: node --test tests/queue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FAKE_CODEX, makeHarness } from './support/harness.mjs';

/* ── Q1-Q2: command shape and thread resolution ──────────────────────────── */

test('Q1 codex_queue resolves the thread name and invokes the official queue command', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  const thread = fixture.addThread({ name: 'queued-target' });
  const text = await bridge.call('codex_queue', { thread: 'queued-target', message: 'queued hello 你好' });

  assert.equal(seam.calls.length, 1);
  assert.deepEqual(seam.calls[0].argv, [
    FAKE_CODEX,
    'queue',
    '--thread',
    thread.id,
    '--message',
    'queued hello 你好',
  ]);
  assert.match(text, /^queued: 0199cccc-0000-7000-8000-000000000003$/mu);
  assert.ok(text.includes('target: queued-target ' + thread.id), text);
  assert.match(text, /channel: codex queue \(delivered and executed by the owning Codex writer\)/u);
});

test('Q2 codex_queue resolves an id prefix to the full thread id', async (t) => {
  const { fixture, seam, bridge } = await makeHarness(t);
  const thread = fixture.addThread({ name: 'prefix-target' });
  await bridge.call('codex_queue', { thread: thread.id.slice(0, 8), message: 'prefix ok' });
  assert.deepEqual(seam.calls[0].argv, [
    FAKE_CODEX,
    'queue',
    '--thread',
    thread.id,
    '--message',
    'prefix ok',
  ]);
});

/* ── Q3-Q4: failure paths ────────────────────────────────────────────────── */

test('Q3 codex_queue failures surface exit code and stderr', async (t) => {
  const { bridge } = await makeHarness(t, {
    setup(fixture) {
      fixture.addThread({ name: 'queue-fail' });
    },
    env: {
      FAKE_CODEX_QUEUE_MODE: 'fail',
      FAKE_CODEX_QUEUE_EXIT: '4',
      FAKE_CODEX_QUEUE_STDERR: 'queue channel unavailable',
    },
  });
  await assert.rejects(
    bridge.call('codex_queue', { thread: 'queue-fail', message: 'x' }),
    /codex queue failed \(exit 4\): queue channel unavailable/u,
  );
});

test('Q4 codex_queue rejects unknown threads and empty messages before spawning', async (t) => {
  const { seam, bridge } = await makeHarness(t);
  await assert.rejects(
    bridge.call('codex_queue', { thread: 'no-such-thread', message: 'x' }),
    /unknown Codex thread "no-such-thread"/u,
  );
  await assert.rejects(
    bridge.call('codex_queue', { thread: 'no-such-thread', message: '   ' }),
    /message must be a non-empty string/u,
  );
  assert.equal(seam.calls.length, 0);
});

/* ── Q5-Q7: waiting for delivery ─────────────────────────────────────────── */

test('Q5 codex_queue waitMs observes the delivered turn and returns its final message', async (t) => {
  const startedAt = Date.now();
  const { fixture, bridge } = await makeHarness(t, {
    setup(fixture) {
      fixture.deliverTarget = fixture.addThread({ name: 'deliver-target' });
    },
    env: (fixture) => ({
      FAKE_CODEX_QUEUE_APPEND: fixture.deliverTarget.file,
      FAKE_CODEX_QUEUE_DELAY_MS: '150',
      FAKE_CODEX_QUEUE_FINAL: 'queued reply done',
    }),
    config: { queuePollMs: 100 },
  });
  const text = await bridge.call('codex_queue', { thread: 'deliver-target', message: 'task list v1', waitMs: 5_000 });
  assert.match(text, /^status: delivered and completed after /mu);
  assert.match(text, /^final message:\nqueued reply done$/mu);
  assert.ok(Date.now() - startedAt < 5_000, 'should return as soon as the turn completes');
});

test('Q6 codex_queue waitMs reports a timeout without claiming completion', async (t) => {
  const { bridge } = await makeHarness(t, {
    setup(fixture) {
      fixture.addThread({ name: 'quiet-target' });
    },
    config: { queuePollMs: 100 },
  });
  const text = await bridge.call('codex_queue', { thread: 'quiet-target', message: 'task list v2', waitMs: 400 });
  assert.match(text, /^status: queued, no completed turn observed within /mu);
  assert.doesNotMatch(text, /final message:/u);
});

test('Q7 codex_queue reports a hung queue command as a timeout error', async (t) => {
  const { bridge } = await makeHarness(t, {
    setup(fixture) {
      fixture.addThread({ name: 'slow-queue' });
    },
    env: { FAKE_CODEX_QUEUE_MODE: 'hang' },
    config: { queueTimeoutMs: 1_000 },
  });
  await assert.rejects(
    bridge.call('codex_queue', { thread: 'slow-queue', message: 'x' }),
    /codex queue failed \(timeout\)/u,
  );
});

/* ── Q9: executable re-resolution when the Codex bin directory changes ───── */

test('Q9 a cached executable path that disappears is re-resolved before dispatch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-exe-'));
  const previousCodexBin = process.env.CODEX_BIN;
  t.after(() => {
    delete process.env.CODEX_BIN;
    if (previousCodexBin !== undefined) process.env.CODEX_BIN = previousCodexBin;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  // Two copies of the fake CLI: the plugin caches the first path at load time,
  // then the Codex desktop update removes it and CODEX_BIN points at the new one.
  const exeA = path.join(root, 'fake-codex-a.mjs');
  const exeB = path.join(root, 'fake-codex-b.mjs');
  fs.copyFileSync(FAKE_CODEX, exeA);
  fs.copyFileSync(FAKE_CODEX, exeB);
  const { fixture, seam, bridge } = await makeHarness(t, {
    config: { executable: exeA },
    setup(harnessFixture) {
      harnessFixture.addThread({ name: 'relocate-target' });
    },
  });
  assert.equal(seam.calls.length, 0);
  fs.rmSync(exeA, { force: true });
  process.env.CODEX_BIN = exeB;
  const text = await bridge.call('codex_queue', { thread: 'relocate-target', message: 'relocated exe' });
  assert.equal(seam.calls.length, 1);
  assert.equal(seam.calls[0].argv[0], exeB);
  assert.match(text, /^queued: /mu);
});

/* ── Q8: codex_send points at the queue channel on writer conflicts ──────── */

test('Q8 codex_send adds a codex_queue hint when another writer owns the thread', async (t) => {
  const { bridge } = await makeHarness(t, {
    setup(fixture) {
      fixture.addThread({ name: 'conflict-target' });
    },
    env: {
      FAKE_CODEX_MODE: 'fail',
      FAKE_CODEX_EXIT_CODE: '1',
      FAKE_CODEX_STDERR: 'thread-store conflict: thread 0199aaaa-0000-7000-8000-000000000001 already has an active writer',
    },
  });
  const text = await bridge.call('codex_send', { thread: 'conflict-target', message: 'hello', waitMs: 2_000 });
  assert.match(text, /^status: failed/mu);
  assert.match(text, /hint: another Codex writer owns this thread/u);
  assert.match(text, /use codex_queue/u);
});
