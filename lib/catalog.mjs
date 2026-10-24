/**
 * Merge the Codex home's separate read-only sources into one thread catalog:
 * session names, rollout activity, goal rows, writer locks, automations.
 */
import {
  readAutomations,
  readGoals,
  readSessionIndex,
  scanRollouts,
  scanWriterLocks,
} from './codex-home.mjs';

/** Build the catalog; names and goals may arrive for threads without local rollouts. */
export async function buildCatalog(home) {
  const index = readSessionIndex(home);
  const rollouts = scanRollouts(home);
  const locks = scanWriterLocks(home);
  const automations = readAutomations(home);
  const goals = await readGoals(home);

  const threads = new Map();
  const ensure = (id) => {
    let thread = threads.get(id);
    if (!thread) {
      thread = { id, name: '', rollout: undefined, lockMtimeMs: 0, goal: undefined, automations: [], indexUpdatedAt: undefined };
      threads.set(id, thread);
    }
    return thread;
  };

  for (const [id, rollout] of rollouts) ensure(id).rollout = rollout;
  for (const [id, entry] of index) {
    const thread = ensure(id);
    if (entry.name) thread.name = entry.name;
    thread.indexUpdatedAt = entry.updatedAt;
  }
  for (const [id, mtimeMs] of locks) ensure(id).lockMtimeMs = mtimeMs;
  for (const automation of automations) {
    if (!automation.targetThreadId) continue;
    ensure(automation.targetThreadId).automations.push(automation);
  }
  if (goals.available) {
    for (const goal of goals.rows) ensure(goal.threadId).goal = goal;
  }

  const merged = [...threads.values()]
    .map((thread) => {
      // Threads that only exist in session_index.jsonl (archived, no local rollout)
      // must still report a meaningful last-activity age instead of the epoch.
      const indexActivityMs = typeof thread.indexUpdatedAt === 'string' ? Date.parse(thread.indexUpdatedAt) : Number.NaN;
      return {
        ...thread,
        lastActivityMs: Math.max(
          thread.rollout?.mtimeMs ?? 0,
          thread.lockMtimeMs,
          thread.goal?.updatedAtMs ?? 0,
          Number.isFinite(indexActivityMs) ? indexActivityMs : 0,
        ),
      };
    })
    .sort((left, right) => right.lastActivityMs - left.lastActivityMs);

  return { home, threads: merged, goalsStatus: goals, automationCount: automations.length };
}

/** Normalize a thread reference (UUID, UUID prefix, or `@name` / name). */
export function resolveThread(threads, reference) {
  if (typeof reference !== 'string' || reference.trim() === '') return undefined;
  const raw = reference.trim();
  const bare = raw.startsWith('@') ? raw.slice(1) : raw;
  const lowered = bare.toLowerCase();
  const byId = threads.find((thread) => thread.id.toLowerCase() === lowered) ??
    threads.find((thread) => thread.id.toLowerCase().startsWith(lowered));
  if (byId) return byId;
  return threads.find((thread) => typeof thread.name === 'string' && thread.name.toLowerCase() === lowered);
}
