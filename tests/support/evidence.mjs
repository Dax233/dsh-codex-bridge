/**
 * Optional local evidence recorder.
 *
 * Set DISPATCH_EVIDENCE_DIR before running `node --test tests/dispatch.test.mjs` to dump
 * one JSON file per recorded observation (argv, env key sets, run outputs, ...). The
 * committed test suite behaves identically when the variable is unset.
 */
import fs from 'node:fs';
import path from 'node:path';

const outputDirectory = process.env.DISPATCH_EVIDENCE_DIR;

export function record(id, value) {
  if (!outputDirectory) return;
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
