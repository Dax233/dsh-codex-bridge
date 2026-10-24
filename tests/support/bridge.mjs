/**
 * Load the REAL plugin (`apply` from index.js) against a fake Host context.
 *
 * The fake context implements only the services the plugin injects/touches:
 *   tools.register(definition)      captures the six tool definitions
 *   effect(fn, label)               runs the effect now and records its disposer
 *   get(name)                       no optional services (workingDirectory absent)
 *   subprocess                      the fake seam from ./fake-seam.mjs
 *
 * The captured tool definitions are called directly (`execute(args, { agent: {} })`),
 * which is exactly what the Host would do after schema validation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const FAKE_CODEX = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-codex.mjs');

/** Thread id the fake codex reports in its thread.started event by default. */
export const FIXED_THREAD_ID = '0199aaaa-0000-7000-8000-000000000001';

/**
 * The fixed continuation prompt codex_liveness sends. This literal must stay in sync
 * with index.js; the B7 test asserts the child receives it byte-for-byte.
 */
export const FIXED_NUDGE_MESSAGE = [
  'DSH liveness check: the official goal for this thread is still active, but no work has been written for a while.',
  'Continue the current research with a concrete next action rather than waiting; report only if you are genuinely blocked on a user decision.',
  'Some unread new messages may exist; read them before starting.',
].join(' ');

export async function makeBridge({ home, config = {}, seam, executable = FAKE_CODEX } = {}) {
  const tools = new Map();
  const registered = [];
  const disposers = [];

  const ctx = {
    subprocess: seam,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        registered.push(definition.name);
        return () => {
          /* keep definitions addressable for post-dispose probes */
        };
      },
    },
    effect(effect) {
      const value = effect();
      const dispose = typeof value === 'function' ? value : () => {};
      disposers.push(dispose);
      return dispose;
    },
    get() {
      return undefined;
    },
  };

  apply(ctx, { codexHome: home, executable, ...config });

  return {
    registered,
    tool(name) {
      const definition = tools.get(name);
      if (!definition) throw new Error(`tool ${name} was not registered`);
      return definition;
    },
    async call(name, args, exec = { agent: {} }) {
      const result = await this.tool(name).execute(args, exec);
      return result.text;
    },
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch {
          /* cleanup must not mask test failures */
        }
      }
    },
  };
}
