#!/usr/bin/env node
/**
 * Fake `codex` CLI for the offline dispatch-plane tests (FIX).
 *
 * The bridge builds `<executable> exec --json --skip-git-repo-check ... -` and writes the
 * prompt on stdin. This script mimics the JSONL protocol parsed by lib/rollout.mjs
 * (`parseExecEvents`) without any network access or model turn.
 *
 * Behaviour is selected with FAKE_CODEX_* environment variables, which the tests pass
 * through the plugin's explicit `config.env` (the only way the bridge lets a caller add
 * child environment). When FAKE_CODEX_CAPTURE is set, every invocation writes an
 * invocation capture (argv, cwd, env, raw stdin bytes + SHA-256) so tests can prove the
 * bytes the child actually received.
 *
 * Modes:
 *   normal       thread.started + item.completed(agent_message) + turn.completed, exit 0
 *   fail         write stderr, exit non-zero (no protocol output)
 *   error-event  protocol `error` event, exit 0 (bridge marks the run failed)
 *   turn-failed  protocol `turn.failed` event with error.message, exit 0
 *   huge         writes FAKE_CODEX_NOISE_BYTES of noise, then a normal event tail
 *   hang         never exits; the bridge's terminate() must kill it
 *
 * Common knobs: FAKE_CODEX_DELAY_MS, FAKE_CODEX_THREAD_ID, FAKE_CODEX_FINAL_MESSAGE,
 * FAKE_CODEX_FINAL_REPEAT_LEN, FAKE_CODEX_TOTAL_TOKENS, FAKE_CODEX_STDERR,
 * FAKE_CODEX_EXIT_CODE, FAKE_CODEX_ERROR, FAKE_CODEX_STARTED.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

function writeAll(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function captureInvocation(stdin) {
  if (!env.FAKE_CODEX_CAPTURE) return;
  const payload = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: { ...env },
    stdinLen: stdin.length,
    stdinB64: stdin.toString('base64'),
    stdinSha256: crypto.createHash('sha256').update(stdin).digest('hex'),
    node: process.version,
  };
  const target = env.FAKE_CODEX_CAPTURE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload));
  fs.renameSync(temporary, target); // last writer wins; per-pid temp avoids interleaved writes
}

const emit = (row) => writeAll(process.stdout, `${JSON.stringify(row)}\n`);

async function main() {
  const stdin = await readStdin();
  captureInvocation(stdin);
  if (env.FAKE_CODEX_STARTED) {
    fs.mkdirSync(path.dirname(env.FAKE_CODEX_STARTED), { recursive: true });
    fs.writeFileSync(env.FAKE_CODEX_STARTED, String(process.pid));
  }
  const threadId = env.FAKE_CODEX_THREAD_ID || '0199aaaa-0000-7000-8000-000000000001';
  const finalMessage = env.FAKE_CODEX_FINAL_REPEAT_LEN
    ? 'x'.repeat(Math.max(0, Number(env.FAKE_CODEX_FINAL_REPEAT_LEN) || 0))
    : env.FAKE_CODEX_FINAL_MESSAGE ?? 'fake codex completed';
  const usage = {
    input_tokens: Number(env.FAKE_CODEX_INPUT_TOKENS ?? 10),
    output_tokens: Number(env.FAKE_CODEX_OUTPUT_TOKENS ?? 2),
    total_tokens: Number(env.FAKE_CODEX_TOTAL_TOKENS ?? 12),
  };
  // Codex CLI 0.163+ reports input/output tokens without total_tokens.
  if (env.FAKE_CODEX_OMIT_TOTAL_TOKENS) delete usage.total_tokens;
  const delay = Number(env.FAKE_CODEX_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

  const finishNormal = async () => {
    await emit({ type: 'thread.started', thread_id: threadId });
    await emit({ type: 'turn.started' });
    await emit({ type: 'item.completed', item: { type: 'agent_message', text: finalMessage } });
    await emit({ type: 'turn.completed', usage });
    process.exitCode = 0;
  };

  switch (env.FAKE_CODEX_MODE || 'normal') {
    case 'normal':
      return finishNormal();
    case 'huge': {
      const noiseBytes = Number(env.FAKE_CODEX_NOISE_BYTES ?? 200_000);
      const line = `${JSON.stringify({ type: 'noise', text: 'n'.repeat(96) })}\n`;
      const count = Math.max(1, Math.ceil(noiseBytes / line.length));
      for (let index = 0; index < count; index += 64) {
        await writeAll(process.stdout, line.repeat(Math.min(64, count - index)));
      }
      return finishNormal();
    }
    case 'fail': {
      await writeAll(process.stderr, env.FAKE_CODEX_STDERR ?? 'fake codex failed: simulated failure\n');
      process.exitCode = Number(env.FAKE_CODEX_EXIT_CODE ?? 3);
      return;
    }
    case 'error-event': {
      await emit({ type: 'thread.started', thread_id: threadId });
      await emit({ type: 'error', message: env.FAKE_CODEX_ERROR ?? 'fake codex reported an error' });
      process.exitCode = 0;
      return;
    }
    case 'turn-failed': {
      await emit({ type: 'thread.started', thread_id: threadId });
      await emit({ type: 'turn.failed', error: { message: env.FAKE_CODEX_ERROR ?? 'fake codex turn failed' } });
      process.exitCode = 0;
      return;
    }
    case 'hang': {
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
      return;
    }
    default: {
      await writeAll(process.stderr, `unknown FAKE_CODEX_MODE: ${env.FAKE_CODEX_MODE}\n`);
      process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  try {
    process.stderr.write(`${error?.stack ?? error}\n`);
  } catch {
    /* stderr already gone */
  }
  process.exit(98);
});
