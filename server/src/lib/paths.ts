import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** App data directory. Override with PGSTUDIO_HOME. */
export const DATA_DIR = process.env.PGSTUDIO_HOME || path.join(os.homedir(), '.pgstudio');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

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
