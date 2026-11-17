import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** App data directory. Override with TUPLOR_HOME (PGSTUDIO_HOME is still honoured for old setups). */
export const DATA_DIR = process.env.TUPLOR_HOME || process.env.PGSTUDIO_HOME || path.join(os.homedir(), '.tuplor');
migrateLegacyDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

/**
 * The app used to be called "PG Studio" and kept its data in ~/.pgstudio.
 * On first start under the new name, move that folder to ~/.tuplor (same volume, so it's a rename)
 * and leave a symlink behind so an old PG Studio install keeps finding its connections.
 */
function migrateLegacyDataDir() {
  if (process.env.TUPLOR_HOME || process.env.PGSTUDIO_HOME) return;
  const legacy = path.join(os.homedir(), '.pgstudio');
  try {
    if (fs.existsSync(DATA_DIR) || !fs.lstatSync(legacy).isDirectory()) return;
    fs.renameSync(legacy, DATA_DIR);
    fs.symlinkSync(DATA_DIR, legacy);
  } catch {
    /* no legacy folder, or it can't be moved: start fresh */
  }
}

export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

/** Read a JSON file from the data dir, returning `fallback` if missing/corrupt. */
export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomically write a JSON file into the data dir. */
export function writeJson(name: string, data: unknown): void {
  const file = dataFile(name);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
