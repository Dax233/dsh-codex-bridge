/**
 * Read-only smoke test: catalog, session meta, transcript tail, goal rows.
 * Run with `node tests/smoke.mjs` on a machine with a Codex home.
 */
import { buildCatalog } from '../lib/catalog.mjs';
import { findCodexExecutable, resolveCodexHome } from '../lib/codex-home.mjs';
import { readSessionMeta, readTailLines, summarizeEvents } from '../lib/rollout.mjs';

const home = resolveCodexHome('');
if (!home) {
  console.log('SKIP: no Codex home found');
  process.exit(0);
}
const executable = findCodexExecutable('', home);
console.log('home:', home);
console.log('executable:', executable ?? '(not found)');

const catalog = await buildCatalog(home);
console.log('threads:', catalog.threads.length, 'goals:', catalog.goalsStatus.available, catalog.goalsStatus.rows.length);
for (const thread of catalog.threads.slice(0, 6)) {
  const age = Math.round((Date.now() - thread.lastActivityMs) / 60000);
  console.log(
    `  ${(thread.name || '(unnamed)').padEnd(10)} ${thread.id} goal=${thread.goal?.status ?? '—'} last=${age}m size=${
      thread.rollout ? `${(thread.rollout.sizeBytes / 1_048_576).toFixed(1)}MB` : '—'
    }`,
  );
}

const named = catalog.threads.find((thread) => thread.name !== '' && thread.rollout !== undefined);
if (named) {
  const meta = readSessionMeta(named.rollout.file);
  console.log('meta:', JSON.stringify(meta));
  const tail = readTailLines(named.rollout.file, 500_000);
  const summary = summarizeEvents(tail.lines, { limit: 3 });
  console.log('tail lines:', tail.lines.length, 'truncated:', tail.truncated, 'last event:', summary.lastEventAt);
  for (const item of summary.items) console.log(`  [${item.kind}] ${item.text.slice(0, 100)}`);
}
