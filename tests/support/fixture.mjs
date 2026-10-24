/**
 * Temporary CODEX_HOME fixtures for offline dispatch-plane tests.
 *
 * Each fixture is a throw-away directory under the OS temp directory containing the
 * read-only surfaces the bridge scans:
 *   session_index.jsonl                        thread id -> friendly name
 *   sessions/YYYY/MM/DD/rollout-*.jsonl        transcript + session meta (cwd)
 *   thread-writer-locks/<id>.lock              advisory writer lock
 *   automations/<id>/automation.toml           automation definition
 *   goals_1.sqlite                            thread_goals rows (node:sqlite)
 *
 * Nothing here touches the real CODEX_HOME. All timestamps are derived from Date.now()
 * minus ageMs so liveness/staleness scenarios can be constructed deterministically.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const now = () => Date.now();

export async function makeFixtureHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-fixture-'));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const workspacesRoot = path.join(root, 'workspaces');
  const main = path.join(workspacesRoot, 'main');
  fs.mkdirSync(main, { recursive: true });
  const captures = path.join(root, 'captures');
  fs.mkdirSync(captures, { recursive: true });
  const spillDir = path.join(root, 'spill');
  fs.mkdirSync(spillDir, { recursive: true });
  const markers = path.join(root, 'markers');
  fs.mkdirSync(markers, { recursive: true });

  const indexEntries = [];
  const goals = [];

  const writeIndex = () => {
    const text = indexEntries.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), indexEntries.length === 0 ? '' : `${text}\n`);
  };

  const sessionsDirectory = () => path.join(home, 'sessions', '2026', '10', '24');

  const fixture = {
    root,
    home,
    workspaces: { main },
    capturePath: path.join(captures, 'capture.json'),
    startedMarker: path.join(markers, 'started'),
    spillDir,

    /** Create (if needed) and return a workspace directory inside the fixture. */
    workspace(name) {
      const directory = path.join(workspacesRoot, name);
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },

    /**
     * Write a rollout file for a thread and register its session_index row.
     * ageMs controls the rollout mtime, which is what the catalog uses as last activity.
     */
    addThread({ id = crypto.randomUUID(), name = '', cwd = main, ageMs = 0, items = [] } = {}) {
      const directory = sessionsDirectory();
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `rollout-2026-10-24T12-00-00-${id}.jsonl`);
      const timestamp = new Date(now() - ageMs).toISOString();
      const header = {
        timestamp,
        type: 'session_meta',
        payload: {
          id,
          session_id: id,
          cwd,
          cli_version: '0.0.0-fake',
          model_provider: 'openai',
          originator: 'codex_cli_rs',
        },
      };
      const lines = [JSON.stringify(header), ...items.map((item) => JSON.stringify(item))];
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      const mtime = new Date(now() - ageMs);
      fs.utimesSync(file, mtime, mtime);
      const updatedAt = timestamp;
      indexEntries.push({ id, thread_name: name, updated_at: updatedAt });
      writeIndex();
      return { id, name, cwd, file, ageMs };
    },

    /** A writer lock file, with mtime aged by ageMs. */
    addLock(threadId, { ageMs = 0 } = {}) {
      const directory = path.join(home, 'thread-writer-locks');
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${threadId}.lock`);
      fs.writeFileSync(file, '');
      const mtime = new Date(now() - ageMs);
      fs.utimesSync(file, mtime, mtime);
      return file;
    },

    /** An automation definition pointing at targetThreadId. */
    addAutomation({ id = crypto.randomUUID(), targetThreadId, kind = 'heartbeat', name = 'fixture automation', status = 'ACTIVE', rrule = 'FREQ=HOURLY' } = {}) {
      const directory = path.join(home, 'automations', id);
      fs.mkdirSync(directory, { recursive: true });
      const text = [
        `id = "${id}"`,
        `kind = "${kind}"`,
        `name = "${name}"`,
        `status = "${status}"`,
        `rrule = "${rrule}"`,
        `target_thread_id = "${targetThreadId}"`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(directory, 'automation.toml'), text);
      return path.join(directory, 'automation.toml');
    },

    /** Add one official goal row and (re)write goals_1.sqlite. */
    addGoal({ threadId, goalId = crypto.randomUUID(), objective = 'fixture objective', status = 'active', tokensUsed = 0, ageMs = 0 }) {
      goals.push({
        thread_id: threadId,
        goal_id: goalId,
        objective,
        status,
        tokens_used: tokensUsed,
        updated_at_ms: now() - ageMs,
      });
      const file = path.join(home, 'goals_1.sqlite');
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${file}${suffix}`, { force: true });
        } catch {
          /* best effort */
        }
      }
      const database = new DatabaseSync(file);
      try {
        database.exec(
          'CREATE TABLE thread_goals (thread_id TEXT, goal_id TEXT, objective TEXT, status TEXT, tokens_used INTEGER, updated_at_ms INTEGER)',
        );
        const insert = database.prepare(
          'INSERT INTO thread_goals (thread_id, goal_id, objective, status, tokens_used, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const goal of goals) {
          insert.run(goal.thread_id, goal.goal_id, goal.objective, goal.status, goal.tokens_used, goal.updated_at_ms);
        }
      } finally {
        database.close();
      }
      return file;
    },

    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };

  return fixture;
}
