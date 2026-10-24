/**
 * One-call test harness: temp CODEX_HOME fixture + fake seam + real plugin instance.
 */
import fs from 'node:fs';
import { makeBridge, FAKE_CODEX, FIXED_NUDGE_MESSAGE, FIXED_THREAD_ID } from './bridge.mjs';
import { createFakeSeam } from './fake-seam.mjs';
import { makeFixtureHome } from './fixture.mjs';

export { FAKE_CODEX, FIXED_NUDGE_MESSAGE, FIXED_THREAD_ID };

/** Poll until predicate() returns a truthy value, or fail with the last error. */
export async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/** Read the invocation capture written by the fake codex, if one is expected. */
export async function readCapture(fixture) {
  return waitFor(
    () => {
      try {
        return JSON.parse(fs.readFileSync(fixture.capturePath, 'utf8'));
      } catch {
        return undefined;
      }
    },
    { label: 'fake codex invocation capture' },
  );
}

/**
 * Build a fresh fixture + fake seam + plugin instance and register teardown on the
 * node:test context. `setup` runs after the fixture exists and before `apply`, so tests
 * can add threads/goals that the plugin will see from its first catalog build.
 *
 * options:
 *   setup(fixture)   fixture mutation hook (sync or async)
 *   env              extra child env (object, or function(fixture) -> object)
 *   capture          set FAKE_CODEX_CAPTURE to the fixture capture path
 *   config           plugin config overrides (home/executable are supplied by the harness)
 */
export async function makeHarness(t, options = {}) {
  const { env = {}, config = {}, capture = false, setup } = options;
  const fixture = await makeFixtureHome();
  if (typeof setup === 'function') await setup(fixture);
  const seam = createFakeSeam({ spillDir: fixture.spillDir });
  const extraEnv = typeof env === 'function' ? { ...env(fixture) } : { ...env };
  if (capture) extraEnv.FAKE_CODEX_CAPTURE = fixture.capturePath;
  const bridge = await makeBridge({
    home: fixture.home,
    seam,
    config: {
      defaultCwd: fixture.workspaces.main,
      defaultWaitMs: 0,
      ...config,
      env: {
        FAKE_CODEX_MODE: 'normal',
        FAKE_CODEX_THREAD_ID: FIXED_THREAD_ID,
        ...extraEnv,
      },
    },
  });
  t.after(async () => {
    bridge.dispose();
    await seam.cleanup();
    fixture.cleanup();
  });
  return { fixture, seam, bridge };
}
