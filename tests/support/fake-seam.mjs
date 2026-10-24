/**
 * Offline stand-in for the DeepSeek Harness subprocess seam.
 *
 * The bridge consumes one shape from the Host (see lib/runner.mjs):
 *
 *   ctx.subprocess.spawn({
 *     argv,
 *     cwd,
 *     stdio: {
 *       stdin:  { data },
 *       stdout: { maxBytes, spill: { maxBytes } },
 *       stderr: { maxBytes },
 *     },
 *     graceMs,
 *     env,
 *   }) -> {
 *     done: Promise<{ exitCode, signal }>,
 *     collected: {
 *       stdout: { readFrom(offset) -> { text, nextOffset, lossy, spillPath? } },
 *       stderr: { readFrom(offset) -> { text, nextOffset, lossy } },
 *     },
 *     terminate(),
 *   }
 *
 * What this fake mirrors about the real seam:
 * - collect mode, not streaming: the caller reads the retained window with readFrom();
 * - each stream keeps the LAST maxBytes bytes and reports lossy=true when earlier bytes
 *   were dropped (the bridge only needs the tail for its JSON event parsing);
 * - stdout with spill enabled writes the retained window to a spill file and exposes
 *   spillPath on the read result;
 * - terminate() sends SIGTERM, then SIGKILL if the child has not exited within graceMs;
 * - a launch failure rejects done (the real seam wraps it as "subprocess failed before
 *   reporting an outcome: ..."), while an invalid configuration that fails before spawn
 *   throws synchronously.
 *
 * Fixture executables are Node scripts. Windows CreateProcess cannot launch a shebang
 * script, so the fake seam runs `process.execPath <fake-codex.mjs> <args...>`. The plugin's
 * argv contract is asserted against the recorded spawn spec, which this translation never
 * mutates. A .cmd/.bat path is also handled for completeness, but the committed tests use
 * the .mjs fixture (documented in tests/fixtures/fake-codex.cmd).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
let nextHandleId = 1;

function cloneSpec(spec = {}) {
  const stdio = spec.stdio ?? {};
  return {
    argv: Array.isArray(spec.argv) ? spec.argv.map((item) => String(item)) : [],
    cwd: spec.cwd,
    graceMs: spec.graceMs,
    env: { ...(spec.env ?? {}) },
    stdio: {
      stdin: { ...(stdio.stdin ?? {}) },
      stdout: { ...(stdio.stdout ?? {}) },
      stderr: { ...(stdio.stderr ?? {}) },
    },
  };
}

function makeStreamState(maxBytes) {
  const limit = Number.isFinite(maxBytes) ? maxBytes : Number.POSITIVE_INFINITY;
  const chunks = [];
  const state = {
    total: 0,
    spillPath: undefined,
    push(chunk) {
      chunks.push(chunk);
      state.total += chunk.length;
    },
    all() {
      return Buffer.concat(chunks, state.total);
    },
    lossy() {
      return state.total > limit;
    },
    retained() {
      const all = state.all();
      return all.length > limit ? all.subarray(all.length - limit) : all;
    },
  };
  return state;
}

function makeReader(state) {
  return {
    readFrom(fromByte = 0) {
      const retained = state.retained();
      const offset = Math.max(0, Math.min(Number(fromByte) || 0, retained.length));
      return {
        text: retained.subarray(offset).toString('utf8'),
        nextOffset: retained.length,
        lossy: state.lossy(),
        ...(state.spillPath !== undefined ? { spillPath: state.spillPath } : {}),
      };
    },
  };
}

const emptyReader = () => ({ readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) });

function resolveCommand(argv) {
  const [file, ...rest] = argv;
  const lowered = String(file ?? '').toLowerCase();
  if (lowered.endsWith('.mjs') || lowered.endsWith('.cjs') || lowered.endsWith('.js')) {
    return { command: process.execPath, args: [file, ...rest], translation: 'node-script' };
  }
  if (IS_WINDOWS && (lowered.endsWith('.cmd') || lowered.endsWith('.bat'))) {
    // Not exercised by the committed tests; kept so the fixture shim remains usable.
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', file, ...rest],
      translation: 'cmd-shim',
    };
  }
  return { command: file, args: rest, translation: 'direct' };
}

/**
 * Create a fake seam instance. The returned object doubles as `ctx.subprocess` and as a
 * recorder/controller for the test:
 *   seam.calls        spawned specs, in call order, cloned at spawn time
 *   seam.handles      live handles with exitInfo / terminateCalls / command / translation
 *   seam.spills       spill files written for lossy stdout
 *   seam.spawnError   set to an Error to make spawn() throw synchronously
 *   seam.doneError    set to an Error to return a handle whose done rejects
 *   seam.cleanup()    terminate leftovers, wait for exits, remove the spill directory
 */
export function createFakeSeam(options = {}) {
  const spillDir = options.spillDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-seam-'));
  const ownsSpillDir = options.spillDir === undefined;

  const seam = {
    spillDir,
    calls: [],
    handles: [],
    spills: [],
    spawnError: null,
    doneError: null,
  };

  seam.spawn = (spec) => {
    const call = cloneSpec(spec);
    seam.calls.push(call);
    if (seam.spawnError) throw seam.spawnError;
    if (seam.doneError) {
      const error = seam.doneError;
      const settled = Promise.reject(error);
      return {
        done: settled,
        collected: { stdout: emptyReader(), stderr: emptyReader() },
        terminateCalls: 0,
        exitInfo: undefined,
        settledPromise: settled.catch(() => undefined),
        terminate() {
          return false;
        },
      };
    }

    const handleId = nextHandleId++;
    const resolved = resolveCommand(call.argv);
    const stdoutState = makeStreamState(call.stdio.stdout.maxBytes);
    const stderrState = makeStreamState(call.stdio.stderr.maxBytes);
    const finalizeSpill = () => {
      const spill = call.stdio.stdout.spill;
      if (!spill || !Number.isFinite(spill.maxBytes)) return;
      if (!stdoutState.lossy()) return;
      const all = stdoutState.all();
      const cap = spill.maxBytes;
      const retained = all.length > cap ? all.subarray(all.length - cap) : all;
      const file = path.join(spillDir, `stdout-${handleId}.log`);
      fs.writeFileSync(file, retained);
      stdoutState.spillPath = file;
      seam.spills.push({ path: file, bytes: retained.length });
    };

    let child;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: call.cwd,
        env: call.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const rejected = Promise.reject(
        new Error(`subprocess failed before reporting an outcome: ${String(error?.message ?? error)}`),
      );
      return {
        done: rejected,
        collected: { stdout: emptyReader(), stderr: emptyReader() },
        terminateCalls: 0,
        exitInfo: undefined,
        settledPromise: rejected.catch(() => undefined),
        terminate() {
          return false;
        },
      };
    }

    const done = new Promise((resolve, reject) => {
      child.on('error', (error) => {
        finalizeSpill();
        reject(new Error(`subprocess failed before reporting an outcome: ${String(error?.message ?? error)}`));
      });
      child.on('close', (exitCode, signal) => {
        finalizeSpill();
        resolve({ exitCode, signal });
      });
    });

    const handle = {
      id: handleId,
      spec: call,
      argv: call.argv,
      command: resolved.command,
      args: resolved.args,
      translation: resolved.translation,
      stdoutState,
      stderrState,
      terminateCalls: 0,
      exitInfo: undefined,
      done,
      collected: { stdout: makeReader(stdoutState), stderr: makeReader(stderrState) },
      terminate() {
        handle.terminateCalls += 1;
        if (handle.exitInfo !== undefined) return false;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        const graceMs = Number.isFinite(call.graceMs) ? Math.max(0, call.graceMs) : 100;
        const timer = setTimeout(() => {
          if (handle.exitInfo === undefined) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }, Math.min(graceMs, 1_000));
        timer.unref?.();
        return true;
      },
    };
    handle.settledPromise = done.then(
      () => undefined,
      () => undefined,
    );
    done.then(
      (outcome) => {
        handle.exitInfo = outcome;
      },
      () => undefined,
    );

    const stdinData = call.stdio.stdin?.data;
    child.stdin.on('error', () => {
      /* the child may exit before consuming stdin; a real seam reports the exit instead */
    });
    if (stdinData === undefined || stdinData === null) child.stdin.end();
    else child.stdin.end(Buffer.from(String(stdinData), 'utf8'));
    child.stdout.on('data', (chunk) => stdoutState.push(chunk));
    child.stderr.on('data', (chunk) => stderrState.push(chunk));
    seam.handles.push(handle);
    return handle;
  };

  seam.cleanup = async () => {
    for (const handle of seam.handles) {
      if (handle.exitInfo === undefined) {
        try {
          handle.terminate();
        } catch {
          /* best effort */
        }
      }
    }
    const settled = Promise.all(seam.handles.map((handle) => handle.settledPromise));
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, 2_000);
      timer.unref?.();
    });
    await Promise.race([settled, timeout]);
    clearTimeout(timer);
    if (ownsSpillDir) {
      try {
        fs.rmSync(spillDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };

  return seam;
}
