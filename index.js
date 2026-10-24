/**
 * dsh-codex-bridge — Host half.
 *
 * Read local Codex threads, dispatch headless turns into them, inspect goal
 * rows and automations, and report liveness. The plugin never writes into the
 * Codex home: transcripts, goals, and locks are read only, and Codex work is
 * driven as child processes through the Harness subprocess seam.
 */
import { buildCatalog, resolveThread } from './lib/catalog.mjs';
import { findCodexExecutable, resolveCodexHome } from './lib/codex-home.mjs';
import { readSessionMeta, readTailLines, summarizeEvents } from './lib/rollout.mjs';
import { createRuns } from './lib/runner.mjs';
import { ageLabel, clip, readConfig, singleLine, stamp, tokensLabel, usageTotal } from './lib/util.mjs';

export const name = 'codex-bridge';
export const inject = ['tools', 'subprocess'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const renderText = (_args, value) => [{ type: 'text', text: value.text }];

const READ_KINDS = ['user', 'assistant', 'heartbeat', 'developer', 'tool', 'turn-end'];

export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const home = resolveCodexHome(config.codexHome);
  const executable = findCodexExecutable(config.executable, home);
  const runs = createRuns({ ctx, config, home, executable });

  ctx.effect(() => () => runs.dispose(), 'codex-bridge.runs');

  const catalogNow = () => buildCatalog(home);

  /** The calling session's workspace, when that service is available. */
  const sessionWorkspace = async (exec) => {
    const service = ctx.get?.('workingDirectory');
    if (!service || !exec?.agent) return undefined;
    try {
      const directory = await service.ensure(exec.agent);
      return typeof directory === 'string' && directory !== '' ? directory : undefined;
    } catch {
      return undefined;
    }
  };

  const missingHome = () =>
    new Error(
      'Codex home not found: set config.codexHome or CODEX_HOME (looked for ~/.codex and the configured path)',
    );

  const requireThread = (catalog, reference) => {
    const thread = resolveThread(catalog.threads, reference);
    if (thread) return thread;
    const known = catalog.threads
      .filter((item) => item.name !== '')
      .slice(0, 12)
      .map((item) => item.name)
      .join(', ');
    throw new Error(
      `unknown Codex thread "${String(reference)}"${known === '' ? '' : `; named threads: ${known}`}`,
    );
  };

  /* ── codex_threads ─────────────────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'codex_threads',
        description:
          'List local Codex threads: friendly name, id, official goal status, last write age, transcript size, automation, and any running bridge turn. Use it to choose a thread for codex_read, codex_send, or codex_liveness.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Case-insensitive filter over thread id and name.' },
            limit: { type: 'number', description: 'Maximum threads to return (1-50, default 15).' },
            activeWithinMinutes: {
              type: 'number',
              description: 'Only threads written within this many minutes.',
            },
          },
          required: [],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        async execute(args) {
          if (!home) throw missingHome();
          const catalog = await catalogNow();
          const query = String(args.query ?? '').trim().toLowerCase();
          const activeWithin = Number(args.activeWithinMinutes);
          const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 15, 1), 50);
          const now = Date.now();
          const rows = catalog.threads
            .filter((thread) => {
              if (query !== '' && !thread.id.toLowerCase().includes(query) && !thread.name.toLowerCase().includes(query)) return false;
              if (Number.isFinite(activeWithin) && activeWithin > 0 && now - thread.lastActivityMs > activeWithin * 60_000) return false;
              return true;
            })
            .slice(0, limit);
          if (rows.length === 0) {
            return { text: `no Codex threads matched (home: ${home})` };
          }
          const lines = rows.map((thread) => {
            const running = runs.runningFor(thread.id) ? 'running' : '';
            const automation = thread.automations
              .map((entry) => `${entry.id}:${entry.status ?? '?'}`)
              .join(',') || '—';
            const goal = thread.goal ? thread.goal.status : '—';
            const size = thread.rollout ? `${(thread.rollout.sizeBytes / 1_048_576).toFixed(1)}MB` : '—';
            return [
              (thread.name === '' ? '(unnamed)' : thread.name).padEnd(10),
              thread.id,
              `goal=${goal.padEnd(8)}`,
              `last=${ageLabel(now - thread.lastActivityMs)}`.padEnd(14),
              `size=${size}`.padEnd(12),
              `auto=${automation}`,
              running,
            ].join(' ');
          });
          const goalsNote = catalog.goalsStatus.available
            ? `goals: ${catalog.goalsStatus.rows.length} rows`
            : `goals unavailable (${catalog.goalsStatus.reason})`;
          return {
            text: [`home: ${home}`, `executable: ${executable ?? '(not found)'}`, goalsNote, ...lines].join('\n'),
          };
        },
      }),
    'codex-bridge.tool.threads',
  );

  /* ── codex_read ───────────────────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'codex_read',
        description:
          'Read the recent transcript of one Codex thread from its rollout file: bounded tail of user/assistant/turn-end/tool items plus session cwd and last event time. Prefer this over reading rollout files directly.',
        parameters: {
          type: 'object',
          properties: {
            thread: { type: 'string', description: 'Thread name or thread id / id prefix.' },
            limit: { type: 'number', description: 'Maximum items to return (1-40, default 12).' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: READ_KINDS },
              description: 'Restrict item kinds; default returns every conversational kind.',
            },
            maxChars: { type: 'number', description: 'Per-item character cap (100-4000, default 600).' },
            tailBytes: { type: 'number', description: 'How many trailing bytes of the rollout to parse (default 1.5MB, max 8MB).' },
          },
          required: ['thread'],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        async execute(args) {
          if (!home) throw missingHome();
          const catalog = await catalogNow();
          const thread = requireThread(catalog, args.thread);
          if (!thread.rollout) {
            throw new Error(`thread "${thread.name || thread.id}" has no local rollout file (no transcript recorded)`);
          }
          const meta = readSessionMeta(thread.rollout.file);
          const maxBytes = Math.min(Math.max(Number(args.tailBytes) || 1_500_000, 65_536), 8_388_608);
          const tail = readTailLines(thread.rollout.file, maxBytes);
          const summary = summarizeEvents(tail.lines, {
            limit: Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 12, 1), 40),
            maxChars: Math.min(Math.max(Number.isInteger(args.maxChars) ? args.maxChars : 600, 100), 4_000),
            kinds: Array.isArray(args.kinds) ? args.kinds : undefined,
          });
          const header = [
            `thread: ${thread.name === '' ? '(unnamed)' : thread.name} ${thread.id}`,
            `cwd: ${meta?.cwd ?? '—'}${meta?.cliVersion ? `  codex-cli ${meta.cliVersion}` : ''}${meta?.modelProvider ? `  provider ${meta.modelProvider}` : ''}`,
            `rollout: ${(thread.rollout.sizeBytes / 1_048_576).toFixed(1)}MB  last write ${ageLabel(Date.now() - thread.rollout.mtimeMs)} ago`,
            `goal: ${thread.goal ? `${thread.goal.status} (updated ${stamp(thread.goal.updatedAtMs)}, ${tokensLabel(thread.goal.tokensUsed)} tokens)` : '—'}`,
            `last event: ${summary.lastEventAt ? `${summary.lastEventAt} (${ageLabel(Date.now() - Date.parse(summary.lastEventAt))} ago)` : '—'}`,
            tail.truncated ? `(tail window ${(maxBytes / 1_048_576).toFixed(1)}MB; older items omitted)` : '(whole file read)',
            '',
          ];
          const items = summary.items.map((item) => {
            const at = item.at ? item.at.slice(5, 16).replace('T', ' ') : '—';
            return `${at} [${item.kind}] ${item.text}`;
          });
          return {
            text: [...header, ...(items.length === 0 ? ['(no matching items in the tail window)'] : items)].join('\n'),
          };
        },
      }),
    'codex-bridge.tool.read',
  );

  /* ── codex_send ───────────────────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'codex_send',
        description:
          'Send a message into a Codex thread as a headless turn (or start a new thread when `thread` is omitted). Returns a run id immediately by default; set waitMs to wait before returning. Poll with codex_run. A running Codex turn in the same thread may reject the write.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message/task text; required and non-empty.' },
            thread: { type: 'string', description: 'Target thread name or id. Omitted starts a new thread.' },
            waitMs: { type: 'number', description: 'Wait this many milliseconds for completion before returning (0 = return immediately, default 0).' },
            cwd: { type: 'string', description: 'Working directory for a new thread, or the child process directory for a resume.' },
            model: { type: 'string', description: 'Optional Codex model override.' },
            approvalPolicy: { type: 'string', description: 'Codex approval policy override (default from plugin config: never).' },
            sandboxMode: { type: 'string', description: 'Codex sandbox mode override; omit to inherit native Codex config.' },
          },
          required: ['message'],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        async execute(args, exec) {
          const message = typeof args.message === 'string' ? args.message : '';
          if (message.trim() === '') throw new Error('message must be a non-empty string');
          if (!executable) {
            throw new Error('codex executable not found: set config.executable or CODEX_BIN');
          }
          const catalog = await catalogNow();
          const threadReference = typeof args.thread === 'string' ? args.thread.trim() : '';
          let kind = 'new';
          let threadId;
          let workdir = args.cwd;
          let label = '(new thread)';
          if (threadReference !== '') {
            const thread = requireThread(catalog, threadReference);
            kind = 'resume';
            threadId = thread.id;
            label = `${thread.name === '' ? '(unnamed)' : thread.name} ${thread.id}`;
            if (!workdir && thread.rollout) workdir = readSessionMeta(thread.rollout.file)?.cwd;
            const active = runs.runningFor(thread.id);
            if (active) {
              return {
                text: `refused: thread ${label} already has a running bridge turn (${active.id}); poll codex_run instead of starting a second writer`,
              };
            }
          }
          if (!workdir) workdir = config.defaultCwd || (await sessionWorkspace(exec));
          const run = runs.start({
            kind,
            threadId,
            prompt: message,
            cwd: workdir,
            model: typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined,
            approvalPolicy:
              typeof args.approvalPolicy === 'string' && args.approvalPolicy.trim() !== ''
                ? args.approvalPolicy.trim()
                : undefined,
            sandboxMode:
              typeof args.sandboxMode === 'string' && args.sandboxMode.trim() !== ''
                ? args.sandboxMode.trim()
                : undefined,
          });
          const waitMs = Number.isFinite(Number(args.waitMs)) ? Number(args.waitMs) : config.defaultWaitMs;
          await runs.wait(run, waitMs);
          const snapshot = runs.snapshot(run);
          const lines = [
            `run: ${snapshot.runId}`,
            `target: ${label}`,
            `status: ${snapshot.status}${snapshot.status === 'running' ? ` (waited ${waitMs}ms; poll codex_run with runId)` : ` after ${ageLabel(snapshot.elapsedMs)}`}`,
          ];
          if (snapshot.threadId) lines.push(`thread: ${snapshot.threadId}`);
          if (snapshot.finalMessage) lines.push('', 'final message:', snapshot.finalMessage);
          if (snapshot.error) lines.push('', `error: ${snapshot.error}`);
          if (snapshot.stderrTail) lines.push('', 'stderr tail:', clip(snapshot.stderrTail, 1_200));
          return { text: lines.join('\n') };
        },
      }),
    'codex-bridge.tool.send',
  );

  /* ── codex_run ───────────────────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'codex_run',
        description:
          'Inspect bridge-dispatched Codex runs: with no runId lists recent runs (id, status, target, age); with a runId returns that run status, final message, usage, and stderr tail.',
        parameters: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Exact run id from codex_send.' },
            limit: { type: 'number', description: 'Maximum runs to list (1-30, default 8).' },
          },
          required: [],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        async execute(args) {
          const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
          if (runId !== '') {
            const run = runs.list().find((item) => item.id === runId);
            if (!run) throw new Error(`unknown run id "${runId}"`);
            const snapshot = runs.snapshot(run);
            const usage = usageTotal(snapshot.usage);
            const lines = [
              `run: ${snapshot.runId}`,
              `status: ${snapshot.status}`,
              `target: ${snapshot.kind === 'resume' ? snapshot.threadId : `(new)${snapshot.threadId ? ` -> ${snapshot.threadId}` : ''}`}`,
              `elapsed: ${ageLabel(snapshot.elapsedMs)}`,
              usage !== undefined ? `usage: ${tokensLabel(usage)}` : '',
              snapshot.stdoutLossy ? '(stdout window truncated; full stream spilled on disk)' : '',
              '',
              'final message:',
              snapshot.finalMessage || '(none yet)',
            ];
            if (snapshot.error) lines.push('', `error: ${snapshot.error}`);
            if (snapshot.stderrTail) lines.push('', 'stderr tail:', clip(snapshot.stderrTail, 1_200));
            return { text: lines.filter((line) => line !== '').join('\n') };
          }
          const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 8, 1), 30);
          const rows = runs.list().slice(0, limit);
          if (rows.length === 0) return { text: 'no bridge runs in this Host session yet' };
          const lines = rows.map((run) => {
            const snapshot = runs.snapshot(run);
            const target = snapshot.kind === 'resume' ? snapshot.threadId : '(new)';
            return `${snapshot.runId}  ${snapshot.status.padEnd(9)} ${target}  ${ageLabel(Date.now() - snapshot.startedAt)} ago  ${singleLine(snapshot.prompt, 60)}`;
          });
          return { text: ['bridge runs (newest first):', ...lines].join('\n') };
        },
      }),
    'codex-bridge.tool.run',
  );

  /* ── codex_goals ──────────────────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'codex_goals',
        description:
          'Read official Codex goal rows for threads: status (active/blocked/paused), token usage, last update, and the objective excerpt. Read-only; goal state changes stay with Codex.',
        parameters: {
          type: 'object',
          properties: {
            thread: { type: 'string', description: 'Filter to one thread name or id.' },
            status: { type: 'string', description: 'Filter by exact status (active, blocked, paused, completed).' },
            limit: { type: 'number', description: 'Maximum rows (1-200, default 40).' },
          },
          required: [],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        async execute(args) {
          if (!home) throw missingHome();
          const catalog = await catalogNow();
          if (!catalog.goalsStatus.available) {
            return { text: `goals unavailable: ${catalog.goalsStatus.reason}` };
          }
          let rows = catalog.goalsStatus.rows;
          const reference = typeof args.thread === 'string' ? args.thread.trim() : '';
          if (reference !== '') {
            const thread = requireThread(catalog, reference);
            rows = rows.filter((row) => row.threadId === thread.id);
          }
          const status = typeof args.status === 'string' ? args.status.trim() : '';
          if (status !== '') rows = rows.filter((row) => row.status === status);
          rows = rows
            .slice()
            .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
            .slice(0, Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 40, 1), 200));
          if (rows.length === 0) return { text: 'no Codex goal rows matched' };
          const nameOf = new Map(catalog.threads.map((thread) => [thread.id, thread.name]));
          const lines = rows.map((row) => {
            const name = nameOf.get(row.threadId) || '(unnamed)';
            return [
              name.padEnd(10),
              row.threadId,
              row.status.padEnd(8),
              `${tokensLabel(row.tokensUsed)} tokens`.padEnd(14),
              `updated ${ageLabel(Date.now() - row.updatedAtMs)} ago`,
              singleLine(row.objective, 110),
            ].join(' ');
          });
          return { text: ['goal rows (newest update first):', ...lines].join('\n') };
        },
      }),
    'codex-bridge.tool.goals',
  );

  /* ── codex_liveness ───────────────────────────────────────────────────── */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'codex_liveness',
        description:
          'Liveness snapshot for Codex threads that carry goals or automations: last write age, goal status, writer-lock freshness, bridge runs, and a verdict. With nudge=true and config.allowNudge, stalled goal-active threads receive one continuation message (never for blocked or paused goals).',
        parameters: {
          type: 'object',
          properties: {
            threads: {
              type: 'array',
              items: { type: 'string' },
              description: 'Thread names or ids to check; default covers goal-carrying, automation-backed, and configured threads.',
            },
            idleMs: { type: 'number', description: 'Idle threshold in milliseconds before a goal-active thread counts as stalled (default from config, 30 min).' },
            nudge: { type: 'boolean', description: 'Send one continuation message to stalled goal-active threads (requires config.allowNudge).' },
          },
          required: [],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        async execute(args) {
          if (!home) throw missingHome();
          const catalog = await catalogNow();
          const idleMs = Math.min(Math.max(Number(args.idleMs) || config.liveness.idleMs, 60_000), 24 * 3_600_000);
          const configuredThreads = new Set(config.liveness.threads.map((item) => item.toLowerCase()));
          const requested = Array.isArray(args.threads) && args.threads.length > 0
            ? args.threads.map((reference) => requireThread(catalog, reference))
            : catalog.threads.filter(
                (thread) =>
                  thread.goal !== undefined ||
                  thread.automations.length > 0 ||
                  configuredThreads.has(thread.name.toLowerCase()) ||
                  configuredThreads.has(thread.id.toLowerCase()),
              );
          if (requested.length === 0) return { text: 'no goal- or automation-backed threads found' };
          const now = Date.now();
          const nudge = args.nudge === true;
          if (nudge && !config.allowNudge) {
            return { text: 'refused: nudge requested but config.allowNudge is false (set allowNudge: true in the plugin config to enable)' };
          }
          const lines = [];
          for (const thread of requested) {
            const label = `${thread.name === '' ? '(unnamed)' : thread.name} ${thread.id}`;
            const age = now - thread.lastActivityMs;
            const running = runs.runningFor(thread.id);
            const goal = thread.goal?.status;
            const automation = thread.automations.find((entry) => entry.status === 'ACTIVE');
            let verdict;
            if (running) verdict = `working (bridge turn ${running.id})`;
            else if (thread.lockMtimeMs > 0 && now - thread.lockMtimeMs < config.liveness.lockFreshMs) verdict = 'working (writer lock fresh)';
            else if (goal === 'active' && age < idleMs) verdict = 'working (goal active)';
            else if (goal === 'active') verdict = `stalled: goal active, no write for ${ageLabel(age)}`;
            else if (goal === 'blocked') verdict = 'blocked goal (needs an authorized resume; not nudged)';
            else if (goal === 'paused') verdict = 'paused goal (not nudged)';
            else if (automation) verdict = `automation thread (idle ${ageLabel(age)})`;
            else verdict = `idle ${ageLabel(age)}`;
            lines.push(
              [
                label.padEnd(48),
                `goal=${(goal ?? '—').padEnd(8)}`,
                `last=${ageLabel(age)}`.padEnd(14),
                verdict,
              ].join(' '),
            );
            if (nudge && verdict.startsWith('stalled') && !running) {
              const message = [
                'DSH liveness check: the official goal for this thread is still active, but no work has been written for a while.',
                'Continue the current research with a concrete next action rather than waiting; report only if you are genuinely blocked on a user decision.',
                'Some unread new messages may exist; read them before starting.',
              ].join(' ');
              try {
                const run = runs.start({ kind: 'resume', threadId: thread.id, prompt: message, cwd: undefined });
                await runs.wait(run, config.nudgeWaitMs);
                const snapshot = runs.snapshot(run);
                lines.push(`  nudged -> run ${snapshot.runId} (${snapshot.status})`);
              } catch (error) {
                lines.push(`  nudge failed: ${String(error?.message ?? error)}`);
              }
            }
          }
          const goalsNote = catalog.goalsStatus.available ? '' : `\n(goals unavailable: ${catalog.goalsStatus.reason})`;
          return {
            text: [`liveness @ ${new Date().toISOString()} (idle threshold ${ageLabel(idleMs)})`, ...lines, goalsNote]
              .filter((line) => line !== '')
              .join('\n'),
          };
        },
      }),
    'codex-bridge.tool.liveness',
  );
}
