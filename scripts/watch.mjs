#!/usr/bin/env node
/**
 * codex-watch - deterministic anomaly check for the DSH <-> Codex relay.
 *
 * The codex-bridge plugin has no background timer and cannot wake a DSH
 * session by itself. This script is the cheap, rule-based half: it reads the
 * same Codex home state as the plugin (rollout heartbeats, goals, automations,
 * liveness) and prints alerts. A DSH schedule (or Windows Task Scheduler) is
 * the wake-up half; only when alerts are non-empty should the relay act.
 *
 * Usage:
 *   node scripts/watch.mjs            # human-readable
 *   node scripts/watch.mjs --json     # machine-readable
 *   node scripts/watch.mjs --thread seori --config watch.config.json
 *
 * Exit codes: 0 = no alerts, 10 = alerts, 2 = check failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, resolveThread } from '../lib/catalog.mjs';
import { resolveCodexHome } from '../lib/codex-home.mjs';
import { readTailLines } from '../lib/rollout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

export const DEFAULT_CONFIG = {
  thread: 'seori',
  home: '',
  heartbeatIntervalMs: 3600000,
  staleAfterMs: 5400000,
  idleAfterMs: 7200000,
  stallHeartbeats: 3,
  requireAutomation: true,
  requiredTemplateKeys: ['STAGE:', 'SUPPORT:', 'GAPS:', 'CHECK:', 'ASOF:'],
  genericPatterns: ['研究仍在推进', '研究在推进', '研究继续推进', '未见偏题'],
  expectedGoals: { sia: 'active', danny: 'active', kiri: 'active', fei: 'blocked' },
};

/** Parse <heartbeat> task_complete rows out of rollout JSONL lines. */
export function parseHeartbeats(lines) {
  const beats = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      continue;
    }
    if (row.type !== 'event_msg' || row.payload?.type !== 'task_complete') continue;
    const text = String(row.payload?.last_agent_message ?? '');
    if (!text.includes('<heartbeat>')) continue;
    const decision = (text.match(/<decision>([^<]+)<\/decision>/u) || [])[1] ?? '?';
    const message = (text.match(/<message>([\s\S]*?)<\/message>/u) || [])[1]?.trim() ?? '';
    beats.push({ at: row.timestamp, atMs: Date.parse(row.timestamp), decision: decision, message: message });
  }
  return beats.sort(function (a, b) { return a.atMs - b.atMs; });
}

function parseStage(message) {
  const line = String(message).split('\n').find(function (item) { return item.startsWith('STAGE:'); });
  if (!line) return undefined;
  const progress = (line.match(/进展\s*=\s*([^\s|]+)/u) || [])[1];
  const evidence = (line.match(/证据\s*=\s*(.+)$/u) || [])[1]?.trim();
  return { line: line, progress: progress, evidence: evidence };
}

function looksLikePath(value) {
  return /[/\\]|\.md|https?:|:\d+/u.test(String(value ?? ''));
}

/**
 * Pure rule evaluation. input carries the already-collected state so tests can
 * exercise every branch without a filesystem.
 */
export function evaluateWatch(input) {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const now = input.now ?? Date.now();
  const alerts = [];
  const add = function (code, severity, message) {
    alerts.push({ code: code, severity: severity, message: message });
  };

  const thread = input.thread;
  if (!thread) {
    add('thread_missing', 'high', 'watch thread "' + config.thread + '" not found in the Codex catalog');
    return { ok: false, alerts: alerts, snapshot: { thread: config.thread } };
  }

  if (config.requireAutomation) {
    const active = (thread.automations ?? []).some(function (item) { return item.status === 'ACTIVE'; });
    if (!active) add('automation_inactive', 'high', 'automation for "' + (thread.name || thread.id) + '" is missing or not ACTIVE');
  }
  if (!thread.rollout) {
    add('rollout_missing', 'warn', 'thread "' + (thread.name || thread.id) + '" has no local rollout; heartbeat checks skipped');
  }
  const idleMs = now - Number(thread.lastActivityMs ?? 0);
  if (Number.isFinite(idleMs) && idleMs > config.idleAfterMs) {
    add('thread_idle', 'warn', 'thread "' + (thread.name || thread.id) + '" has no write for ' + Math.round(idleMs / 60000) + 'm');
  }

  const beats = [...(input.heartbeats ?? [])].sort(function (a, b) { return a.atMs - b.atMs; });
  const latest = beats[beats.length - 1];
  if (!latest) {
    add('heartbeat_missing', 'high', 'no <heartbeat> completion found in the rollout tail');
  } else {
    const ageMs = now - latest.atMs;
    if (ageMs > config.staleAfterMs) {
      add('heartbeat_stale', 'high', 'latest heartbeat is ' + Math.round(ageMs / 60000) + 'm old (threshold ' + Math.round(config.staleAfterMs / 60000) + 'm)');
    }
    const substantive = latest.decision === 'NOTIFY' || latest.message.includes('STAGE:');
    if (substantive) {
      const missing = config.requiredTemplateKeys.filter(function (key) { return !latest.message.includes(key); });
      if (missing.length > 0) {
        add('template_missing', 'warn', 'substantive heartbeat (decision=' + latest.decision + ') lacks: ' + missing.join(', '));
      }
      const stage = parseStage(latest.message);
      if (stage && /有/u.test(stage.progress ?? '') && !looksLikePath(stage.evidence)) {
        add('stage_no_evidence', 'warn', 'STAGE claims progress but the evidence field has no path/line reference');
      }
      if (!latest.message.includes('CHECK:') && config.genericPatterns.some(function (pattern) { return latest.message.includes(pattern); })) {
        add('generic_receipt', 'warn', 'heartbeat claims progress in generic words without a CHECK scope line');
      }
      const recent = beats.filter(function (item) { return item.decision === 'NOTIFY' || item.message.includes('STAGE:'); }).slice(-config.stallHeartbeats);
      if (recent.length >= config.stallHeartbeats) {
        const stalled = recent.every(function (item) {
          return /未推进/u.test(parseStage(item.message)?.progress ?? '');
        });
        if (stalled) add('stage_stalled', 'info', 'last ' + config.stallHeartbeats + ' substantive heartbeats all report 进展=未推进');
      }
    }
  }

  const goals = new Map((input.goals ?? []).map(function (row) { return [row.threadId, row.status]; }));
  const watchedGoals = {};
  for (const [name, expected] of Object.entries(config.expectedGoals ?? {})) {
    const target = (input.threads ?? []).find(function (item) { return item.name?.toLowerCase() === name.toLowerCase(); });
    if (!target) {
      add('goal_thread_missing', 'warn', 'expected researcher thread "' + name + '" not found');
      watchedGoals[name] = 'thread_missing';
      continue;
    }
    const actual = goals.get(target.id);
    watchedGoals[name] = actual === undefined ? 'missing' : actual;
    if (actual === undefined) {
      add('goal_missing', 'warn', 'thread "' + name + '" has no official goal row (expected ' + expected + ')');
    } else if (actual !== expected) {
      add('goal_drift', 'warn', 'thread "' + name + '" goal is ' + actual + ' (expected ' + expected + '); verify whether this change was authorized');
    }
  }

  return {
    ok: alerts.length === 0,
    alerts: alerts,
    snapshot: {
      thread: { id: thread.id, name: thread.name, lastActivityMs: thread.lastActivityMs },
      latestHeartbeatAt: latest?.at,
      latestDecision: latest?.decision,
      goals: watchedGoals,
      checkedAt: new Date(now).toISOString(),
    },
  };
}

function loadConfigFile(explicitPath) {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(REPO, 'watch.config.json');
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('cannot read watch config ' + file + ': ' + String(error?.message ?? error));
  }
}

export async function collectState(options) {
  const opts = options ?? {};
  const config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const home = resolveCodexHome(config.home);
  if (!home) throw new Error('Codex home not found (config.home / CODEX_HOME / ~/.codex)');
  const catalog = await buildCatalog(home);
  const thread = resolveThread(catalog.threads, config.thread);
  let heartbeats = [];
  if (thread?.rollout) {
    const tail = readTailLines(thread.rollout.file, opts.tailBytes ?? 4194304);
    heartbeats = parseHeartbeats(tail.lines);
  }
  return {
    now: Date.now(),
    thread: thread,
    threads: catalog.threads.map(function (item) { return { id: item.id, name: item.name }; }),
    goals: catalog.goalsStatus.available ? catalog.goalsStatus.rows : [],
    heartbeats: heartbeats,
    config: config,
    home: home,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const threadIndex = argv.indexOf('--thread');
  const configIndex = argv.indexOf('--config');
  const overrides = {};
  if (threadIndex >= 0) overrides.thread = argv[threadIndex + 1];
  let fileConfig = {};
  try {
    fileConfig = loadConfigFile(configIndex >= 0 ? argv[configIndex + 1] : undefined);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 2;
    return;
  }
  const config = { ...DEFAULT_CONFIG, ...fileConfig, ...overrides };
  let result;
  try {
    result = evaluateWatch(await collectState({ config: config }));
  } catch (error) {
    console.error('watch failed: ' + String(error?.message ?? error));
    process.exitCode = 2;
    return;
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const t = result.snapshot.thread ?? {};
    console.log('watch ' + new Date().toISOString() + ' thread=' + (t.name || t.id || config.thread) + ' latest=' + (result.snapshot.latestHeartbeatAt ?? '-') + ' decision=' + (result.snapshot.latestDecision ?? '-'));
    if (result.ok) console.log('clean: no alerts');
    else result.alerts.forEach(function (alert) { console.log('[' + alert.severity + '] ' + alert.code + ': ' + alert.message); });
  }
  process.exitCode = result.ok ? 0 : 10;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
