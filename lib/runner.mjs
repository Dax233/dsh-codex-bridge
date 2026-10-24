/**
 * Headless Codex turns through the Harness subprocess seam.
 *
 * One `codex exec` (or `codex exec resume`) process per run. Output is
 * collected, not piped, so the plugin can read it without consuming the stream;
 * runs are tracked by id and can be polled or awaited.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { parseExecEvents } from './rollout.mjs';
import { clip, singleLine } from './util.mjs';

/** Environment names a Codex child needs; credentials are intentionally absent. */
const ENV_KEYS = [
  'SystemRoot',
  'ComSpec',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'WINDIR',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
];

export function createRuns({ ctx, config, home, executable }) {
  const runs = new Map();
  let disposed = false;

  const buildEnv = () => {
    const env = {};
    for (const key of ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    if (home) env.CODEX_HOME = home;
    env.NO_COLOR = '1';
    env.TERM = 'dumb';
    for (const [key, value] of Object.entries(config.env ?? {})) env[key] = value;
    return env;
  };

  const resolveWorkdir = (cwd) => {
    for (const candidate of [cwd, config.defaultCwd, process.cwd()]) {
      if (typeof candidate !== 'string' || candidate.trim() === '') continue;
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        /* try next */
      }
    }
    return process.cwd();
  };

  const readCollected = (run) => {
    const stdout = (() => {
      try {
        return run.handle?.collected?.stdout?.readFrom(0) ?? undefined;
      } catch {
        return undefined;
      }
    })();
    const stderr = (() => {
      try {
        return run.handle?.collected?.stderr?.readFrom(0) ?? undefined;
      } catch {
        return undefined;
      }
    })();
    return {
      stdoutText: stdout?.text ?? '',
      stdoutLossy: stdout?.lossy === true,
      stdoutSpillPath: stdout?.spillPath,
      stderrText: stderr?.text ?? '',
    };
  };

  const finalize = (run, outcome) => {
    if (run.status !== 'running') return;
    run.endedAt = Date.now();
    run.exitCode = outcome?.exitCode ?? null;
    run.signal = outcome?.signal ?? null;
    const output = readCollected(run);
    run.stdout = output.stdoutText;
    run.stderr = output.stderrText;
    run.stdoutLossy = output.stdoutLossy;
    run.stdoutSpillPath = output.stdoutSpillPath;
    const parsed = parseExecEvents(run.stdout);
    if (parsed.threadId && !run.threadId) run.threadId = parsed.threadId;
    run.finalMessage = parsed.finalMessage ?? '';
    run.usage = parsed.usage;
    run.error = parsed.error;
    const exitCode = run.exitCode ?? 1;
    run.status = exitCode === 0 && parsed.error === undefined ? 'completed' : 'failed';
    if (run.finalMessage === '' && run.status === 'failed') {
      run.finalMessage = clip(singleLine(run.stderr, 1_200) || 'codex exited without a message', 1_200);
    }
  };

  const buildArgv = ({ kind, threadId, cwd, model, approvalPolicy, sandboxMode }) => {
    const common = [];
    if (model) common.push('-m', model);
    if (approvalPolicy) common.push('-c', `approval_policy=${approvalPolicy}`);
    if (sandboxMode) common.push('-c', `sandbox_mode=${sandboxMode}`);
    if (kind === 'resume') return [executable, 'exec', 'resume', '--json', '--skip-git-repo-check', ...common, threadId, '-'];
    return [executable, 'exec', '--json', '--skip-git-repo-check', '-C', resolveWorkdir(cwd), ...common, '-'];
  };

  const start = ({ kind, threadId, prompt, cwd, model, approvalPolicy, sandboxMode }) => {
    if (disposed) throw new Error('codex bridge is shutting down');
    if (!executable) {
      throw new Error('codex executable not found: set config.executable, CODEX_BIN, or install the Codex desktop app');
    }
    const id = randomUUID();
    const run = {
      id,
      kind,
      threadId,
      startedAt: Date.now(),
      status: 'running',
      promptPreview: singleLine(prompt, 200),
      stdout: '',
      stderr: '',
      finalMessage: '',
      error: undefined,
      usage: undefined,
      handle: undefined,
      settled: undefined,
    };
    const argv = buildArgv({
      kind,
      threadId,
      cwd,
      model,
      approvalPolicy: approvalPolicy ?? config.approvalPolicy,
      sandboxMode: sandboxMode ?? config.sandboxMode,
    });
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: resolveWorkdir(cwd),
      stdio: {
        stdin: { data: prompt },
        stdout: { maxBytes: config.maxOutputBytes, spill: { maxBytes: config.spillBytes } },
        stderr: { maxBytes: config.maxStderrBytes },
      },
      graceMs: 5_000,
      env: buildEnv(),
    });
    run.handle = handle;
    run.settled = handle.done.then(
      (outcome) => {
        finalize(run, outcome);
      },
      (error) => {
        run.status = 'failed';
        run.endedAt = Date.now();
        run.error = String(error?.message ?? error);
        if (run.finalMessage === '') run.finalMessage = run.error;
      },
    );
    runs.set(id, run);
    return run;
  };

  const wait = async (run, waitMs) => {
    if (!run || run.status !== 'running' || waitMs <= 0) return;
    const budget = Math.min(waitMs, config.maxWaitMs);
    let timer;
    try {
      await Promise.race([
        run.settled,
        new Promise((resolve) => {
          timer = setTimeout(resolve, budget);
          if (typeof timer?.unref === 'function') timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const snapshot = (run) => ({
    runId: run.id,
    kind: run.kind,
    threadId: run.threadId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt,
    exitCode: run.exitCode,
    prompt: run.promptPreview,
    finalMessage: clip(run.finalMessage, 6_000),
    error: run.error,
    usage: run.usage,
    stdoutLossy: run.stdoutLossy === true,
    stderrTail: clip(run.stderr, 1_500),
    stderrSpillPath: undefined,
  });

  const list = () => [...runs.values()].sort((left, right) => right.startedAt - left.startedAt);

  const runningFor = (threadId) =>
    list().find((run) => run.threadId === threadId && run.status === 'running');

  const dispose = () => {
    disposed = true;
    for (const run of runs.values()) {
      if (run.status !== 'running') continue;
      try {
        run.handle?.terminate();
      } catch {
        /* ignore */
      }
    }
  };

  return { start, wait, list, snapshot, runningFor, dispose, executable, home };
}
