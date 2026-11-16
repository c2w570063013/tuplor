import type { FastifyInstance } from 'fastify';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type {
  BackupFile, BackupOptions, BackupTreeSchema, BinaryInfo, BinaryName, BinDirCandidate, JobInfo, JobLogResponse,
  LogLine, RestoreFormat, RestoreOptions, ToolsInfo,
} from '../../../shared/backup';
import type { ConnectionConfig } from '../../../shared/types';
import pg from 'pg';
import { connectClient, queryRows } from '../db';
import { HttpError } from '../lib/errors';
import { DATA_DIR, readJson, writeJson } from '../lib/paths';
import { quoteIdent } from '../lib/sql';
import { getConnectionWithSecret } from '../store';

/**
 * Backup & restore via the PostgreSQL client binaries.
 *
 * - Binaries are auto-detected (custom dir, PATH, Homebrew, Postgres.app, Debian/RHEL layouts,
 *   Windows installer) and matched against the server's major version.
 * - Jobs run as child processes. The password is passed via PGPASSWORD in the child's
 *   environment only — never on the command line. Logs are kept in memory and polled
 *   incrementally by the UI (GET /api/backup/jobs/:id?since=N).
 * - Backup files live in ~/.pgstudio/backups/ (metadata in ~/.pgstudio/backups.json).
 */

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
const SETTINGS_FILE = 'backup-settings.json';
const INDEX_FILE = 'backups.json';
const EXE = process.platform === 'win32' ? '.exe' : '';
const BINARIES: BinaryName[] = ['pg_dump', 'pg_restore', 'psql'];

interface BackupSettings { binDir?: string | null }
interface IndexEntry { database: string; connName: string; note: string; format: RestoreFormat; createdAt: string }

// ------------------------------------------------------------------ binaries

function exists(p: string) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function candidateDirs(custom: string | null | undefined): { dir: string; source: string }[] {
  const out: { dir: string; source: string }[] = [];
  if (custom) out.push({ dir: custom, source: 'custom' });
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) out.push({ dir: d, source: 'PATH' });
  for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const d of subdirs(root)) if (/\/(postgresql(@\d+)?|libpq)$/.test(d)) out.push({ dir: path.join(d, 'bin'), source: 'Homebrew' });
  }
  out.push({ dir: '/opt/homebrew/bin', source: 'Homebrew' }, { dir: '/usr/local/bin', source: 'Homebrew' });
  for (const root of ['/Applications/Postgres.app/Contents/Versions', path.join(os.homedir(), 'Applications/Postgres.app/Contents/Versions')]) {
    for (const d of subdirs(root)) out.push({ dir: path.join(d, 'bin'), source: 'Postgres.app' });
  }
  for (const d of subdirs('/usr/lib/postgresql')) out.push({ dir: path.join(d, 'bin'), source: 'system' });
  for (const d of subdirs('/usr')) if (/\/pgsql-\d+$/.test(d)) out.push({ dir: path.join(d, 'bin'), source: 'system' });
  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      for (const d of subdirs(root)) out.push({ dir: path.join(d, 'bin'), source: 'PostgreSQL installer' });
    }
  }
  // dedupe by real path
  const seen = new Set<string>();
  return out.filter((c) => {
    let real = c.dir;
    try { real = fs.realpathSync(c.dir); } catch { return false; }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function versionOf(bin: string): Promise<{ version: string; major: number } | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /\)\s*(\d+)(?:\.(\d+))?/.exec(stdout) ?? /(\d+)(?:\.(\d+))?/.exec(stdout);
      if (!m) return resolve(null);
      resolve({ version: m[2] ? `${m[1]}.${m[2]}` : m[1], major: Number(m[1]) });
    });
  });
}

let candCache: { at: number; custom: string | null; list: BinDirCandidate[] } | null = null;
async function detectCandidates(custom: string | null): Promise<BinDirCandidate[]> {
  if (candCache && candCache.custom === custom && Date.now() - candCache.at < 60_000) return candCache.list;
  const list: BinDirCandidate[] = [];
  for (const c of candidateDirs(custom)) {
    const bin = path.join(c.dir, 'pg_dump' + EXE);
    if (!exists(bin)) continue;
    const v = await versionOf(bin);
    if (v) list.push({ dir: c.dir, version: v.version, major: v.major, source: c.source });
  }
  candCache = { at: Date.now(), custom, list };
  return list;
}

function settings(): BackupSettings {
  return readJson<BackupSettings>(SETTINGS_FILE, {});
}

async function serverVersion(connId: string): Promise<{ version: string; major: number } | null> {
  try {
    const [r] = await queryRows<{ v: string; n: string }>(connId, undefined, `SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n`);
    return { version: r.v.split(' ')[0], major: Math.floor(Number(r.n) / 10000) };
  } catch {
    return null;
  }
}

async function detectTools(connId: string | null): Promise<ToolsInfo> {
  const custom = settings().binDir ?? null;
  const candidates = await detectCandidates(custom);
  const srv = connId ? await serverVersion(connId) : null;
  let chosen: BinDirCandidate | undefined = custom ? candidates.find((c) => c.source === 'custom') : undefined;
  if (!chosen && srv) {
    chosen = candidates.find((c) => c.major === srv.major)
      ?? [...candidates].filter((c) => c.major > srv.major).sort((a, b) => a.major - b.major)[0];
  }
  if (!chosen) chosen = [...candidates].sort((a, b) => b.major - a.major)[0];

  const binaries = {} as Record<BinaryName, BinaryInfo>;
  for (const name of BINARIES) {
    let p: string | null = chosen ? path.join(chosen.dir, name + EXE) : null;
    if (p && !exists(p)) {
      // e.g. a libpq-only dir without pg_restore: look for the same major elsewhere
      const alt = candidates.find((c) => c.major === chosen!.major && exists(path.join(c.dir, name + EXE)));
      p = alt ? path.join(alt.dir, name + EXE) : null;
    }
    const v = p ? await versionOf(p) : null;
    binaries[name] = { name, path: p, version: v?.version ?? null, major: v?.major ?? null };
  }

  let status: ToolsInfo['status'] = 'ok';
  let message: string | null = null;
  const dumpMajor = binaries.pg_dump.major;
  if (!binaries.pg_dump.path || !binaries.pg_restore.path || !binaries.psql.path) {
    status = 'missing';
    const missing = BINARIES.filter((b) => !binaries[b].path).join(', ');
    message = `Couldn't find ${missing}. Install the PostgreSQL client tools (e.g. "brew install libpq" or "brew install postgresql@${srv?.major ?? 18}") or choose their folder.`;
  } else if (srv && dumpMajor != null && dumpMajor < srv.major) {
    status = 'older';
    message = `pg_dump ${binaries.pg_dump.version} is older than the server (${srv.version}); pg_dump refuses to dump newer servers. Install PostgreSQL ${srv.major} client tools or choose another folder.`;
  } else if (srv && dumpMajor != null && dumpMajor > srv.major) {
    status = 'newer';
    message = `Client tools ${binaries.pg_dump.version} are newer than the server (${srv.version}). Dumps work fine; plain SQL restored into an older server may need small edits.`;
  }
  return {
    customBinDir: custom,
    binDir: chosen?.dir ?? null,
    binaries,
    candidates,
    serverVersion: srv?.version ?? null,
    serverMajor: srv?.major ?? null,
    status,
    message,
  };
}

// ------------------------------------------------------------------ files

function safeName(name: string): string {
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.') || base !== name) throw new HttpError(400, 'Invalid file name');
  return base;
}
function filePath(name: string): string {
  return path.join(BACKUP_DIR, safeName(name));
}
function sanitizeStem(s: string): string {
  return s.replace(/[^\w.\-@+]+/g, '_').replace(/^[._]+/, '').slice(0, 120) || 'backup';
}
function uniqueName(stem: string, ext: string): string {
  let name = stem + ext;
  for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `${stem}-${i}${ext}`;
  return name;
}
function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readIndex(): Record<string, IndexEntry> {
  return readJson<Record<string, IndexEntry>>(INDEX_FILE, {});
}
function updateIndex(fn: (idx: Record<string, IndexEntry>) => void) {
  const idx = readIndex();
  fn(idx);
  writeJson(INDEX_FILE, idx);
}

/** Cheap format detection from the header (+ name hint for tar flavours). */
async function sniffFormat(p: string): Promise<RestoreFormat | 'unknown'> {
  let buf: Buffer;
  try {
    const fh = await fsp.open(p, 'r');
    try {
      buf = Buffer.alloc(512);
      const { bytesRead } = await fh.read(buf, 0, 512, 0);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return 'unknown';
  }
  if (buf.subarray(0, 5).toString('latin1') === 'PGDMP') return 'custom';
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'plain-gz';
  if (buf.length >= 262 && buf.subarray(257, 262).toString('latin1') === 'ustar') {
    if (p.endsWith('.dir.tar')) return 'directory';
    return 'tar';
  }
  if (!buf.includes(0)) return 'plain';
  return 'unknown';
}

/** Precise detection for restore: distinguishes pg_dump tar format from a tarred directory dump. */
async function detectFormat(p: string): Promise<RestoreFormat | 'unknown'> {
  const f = await sniffFormat(p);
  if (f !== 'tar' && f !== 'directory') return f;
  const list = await new Promise<string[]>((resolve) => {
    execFile('tar', ['-tf', p], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? [] : out.split('\n').map((s) => s.replace(/^\.\//, ''))));
  });
  if (list.includes('restore.sql')) return 'tar';
  if (list.includes('toc.dat')) return 'directory';
  return f;
}

async function listFiles(): Promise<BackupFile[]> {
  const idx = readIndex();
  const out: BackupFile[] = [];
  for (const d of await fsp.readdir(BACKUP_DIR, { withFileTypes: true })) {
    if (!d.isFile() || d.name.startsWith('.')) continue;
    const p = path.join(BACKUP_DIR, d.name);
    const st = await fsp.stat(p);
    const meta = idx[d.name];
    out.push({
      name: d.name,
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      format: meta?.format ?? (await sniffFormat(p)),
      database: meta?.database || null,
      connName: meta?.connName || null,
      note: meta?.note ?? null,
    });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function sizeOf(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const f of await fsp.readdir(p)) total += await sizeOf(path.join(p, f));
    return total;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ jobs

interface Job {
  info: JobInfo;
  lines: LogLine[];
  /** absolute index of lines[0] */
  base: number;
  t0: number;
  proc: ChildProcess | null;
  canceled: boolean;
  cleanup: string[];
}
const MAX_LINES = 5000;
const jobs = new Map<string, Job>();

function newJob(kind: JobInfo['kind'], conn: ConnectionConfig, database: string, file: string, format: RestoreFormat, bytes = 0): Job {
  const info: JobInfo = {
    id: crypto.randomUUID(), kind, status: 'running', connId: conn.id, connName: conn.name, database, file, format,
    command: '', startedAt: new Date().toISOString(), finishedAt: null, durationMs: 0, bytes, progress: null,
    progressLabel: null, exitCode: null, lineCount: 0, errors: [], warnings: 0, summary: null,
  };
  const job: Job = { info, lines: [], base: 0, t0: Date.now(), proc: null, canceled: false, cleanup: [] };
  jobs.set(info.id, job);
  // keep the last 30 jobs
  const all = [...jobs.values()];
  for (const j of all.slice(0, Math.max(0, all.length - 30))) if (j.info.status !== 'running') jobs.delete(j.info.id);
  return job;
}

function log(job: Job, level: LogLine['level'], text: string, count = true) {
  if (!text.trim()) return;
  job.lines.push({ t: Date.now() - job.t0, level, text });
  job.info.lineCount++;
  if (job.lines.length > MAX_LINES) {
    const drop = job.lines.length - MAX_LINES;
    job.lines.splice(0, drop);
    job.base += drop;
  }
  if (!count) return;
  if (level === 'error' && job.info.errors.length < 200) job.info.errors.push(text);
  if (level === 'warning') job.info.warnings++;
}

function classify(line: string): LogLine['level'] {
  if (/(^|\s)(ERROR|FATAL|PANIC):|pg_(dump|restore): error:|^psql: error:|could not connect|No such file/i.test(line)) return 'error';
  if (/WARNING:|: warning:/i.test(line)) return 'warning';
  return 'info';
}

function lineSplitter(onLine: (l: string) => void) {
  let rest = '';
  return {
    push(chunk: Buffer) {
      rest += chunk.toString('utf8');
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const p of parts) onLine(p);
    },
    end() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

function pgEnv(conn: ConnectionConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGAPPNAME: 'PG Studio', PGCONNECT_TIMEOUT: '10' };
  for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSERVICE', 'PGOPTIONS']) delete env[k];
  if (conn.password) env.PGPASSWORD = conn.password;
  else delete env.PGPASSWORD;
  if (conn.sslMode) env.PGSSLMODE = conn.sslMode;
  return env;
}
function connArgs(conn: ConnectionConfig): string[] {
  return ['-h', conn.host, '-p', String(conn.port || 5432), '-U', conn.user];
}
function displayCommand(bin: string, args: string[]) {
  const q = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const home = os.homedir();
  const short = (a: string) => (a.startsWith(home + path.sep) ? '~' + a.slice(home.length) : a);
  return [path.basename(bin), ...args.map((a) => q(short(a)))].join(' ');
}

/** Spawn a process, stream its output into the job log. Resolves with the exit code. */
function run(
  job: Job, bin: string, args: string[], env: NodeJS.ProcessEnv,
  opts: { stdin?: Readable; onLine?: (l: string) => void; skip?: (l: string) => boolean } = {},
): Promise<number> {
  return new Promise((resolve) => {
    log(job, 'cmd', '$ ' + displayCommand(bin, args));
    const proc = spawn(bin, args, { env, stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    job.proc = proc;
    const handle = (l: string) => {
      opts.onLine?.(l);
      if (!opts.skip?.(l)) log(job, classify(l), l);
    };
    const out = lineSplitter(handle);
    const err = lineSplitter(handle);
    proc.stdout!.on('data', out.push);
    proc.stderr!.on('data', err.push);
    if (opts.stdin) {
      proc.stdin!.on('error', () => { /* EPIPE when the child exits early */ });
      opts.stdin.on('error', (e) => { log(job, 'error', `read error: ${e.message}`); proc.kill('SIGTERM'); });
      opts.stdin.pipe(proc.stdin!);
    }
    proc.on('error', (e) => {
      log(job, 'error', `failed to start ${path.basename(bin)}: ${e.message}`);
      resolve(-1);
    });
    proc.on('close', (code, signal) => {
      out.end();
      err.end();
      job.proc = null;
      resolve(code ?? (signal ? -2 : -1));
    });
  });
}

function finish(job: Job, code: number) {
  const i = job.info;
  i.exitCode = code;
  i.finishedAt = new Date().toISOString();
  i.durationMs = Date.now() - job.t0;
  i.status = job.canceled ? 'canceled' : code === 0 ? 'success' : 'error';
  if (i.status === 'success') i.progress = 1;
  for (const p of job.cleanup) fs.rmSync(p, { recursive: true, force: true });
  job.cleanup = [];
}

function cancelJob(job: Job) {
  if (job.info.status !== 'running') return;
  job.canceled = true;
  log(job, 'warning', 'Cancel requested…');
  const proc = job.proc;
  if (proc) {
    proc.kill('SIGTERM');
    setTimeout(() => { if (job.proc === proc) proc.kill('SIGKILL'); }, 4000).unref();
  }
}

const runTar = (job: Job, args: string[]) => run(job, 'tar', args, process.env);

// ------------------------------------------------------------------ backup

const FORMAT_FLAG: Record<BackupOptions['format'], string> = { custom: 'c', plain: 'p', directory: 'd', tar: 't' };

function qualifiedPattern(id: string) {
  const i = id.indexOf('.');
  return i < 0 ? quoteIdent(id) : `${quoteIdent(id.slice(0, i))}.${quoteIdent(id.slice(i + 1))}`;
}

async function startBackup(conn: ConnectionConfig, db: string, o: BackupOptions): Promise<JobInfo> {
  const tools = await detectTools(conn.id);
  const pgDump = tools.binaries.pg_dump.path;
  if (!pgDump) throw new HttpError(400, tools.message ?? 'pg_dump not found');
  if (tools.status === 'older') throw new HttpError(400, tools.message!);
  if (o.scope === 'schemas' && !o.schemas?.length) throw new HttpError(400, 'Select at least one schema');
  if (o.scope === 'tables' && !o.tables?.length) throw new HttpError(400, 'Select at least one table');
  if (o.schemaOnly && o.dataOnly) throw new HttpError(400, '"Schema only" and "Data only" are mutually exclusive');

  const compress = o.compression != null && o.compression > 0 && o.format !== 'tar';
  const ext = o.format === 'custom' ? '.dump' : o.format === 'tar' ? '.tar' : o.format === 'directory' ? '.dir.tar' : compress ? '.sql.gz' : '.sql';
  const name = uniqueName(sanitizeStem(o.fileName || `${db}_${stamp()}`), ext);
  const out = path.join(BACKUP_DIR, name);
  const job = newJob('backup', conn, db, name, o.format === 'plain' && compress ? 'plain-gz' : o.format);

  const tmpDir = path.join(BACKUP_DIR, `.tmp-${job.info.id}`);
  const args = ['--verbose', ...connArgs(conn), '-d', db, '-F', FORMAT_FLAG[o.format]];
  if (o.format === 'directory') {
    args.push('-f', tmpDir);
    if (o.jobs > 1) args.push('-j', String(Math.min(16, Math.floor(o.jobs))));
  } else {
    args.push('-f', out);
  }
  if (o.schemaOnly) args.push('--schema-only');
  if (o.dataOnly) args.push('--data-only');
  if (o.noOwner) args.push('--no-owner');
  if (o.noPrivileges) args.push('--no-privileges');
  if (o.format === 'plain' && o.clean && !o.dataOnly) args.push('--clean', '--if-exists');
  if (o.format === 'plain' && o.create) args.push('--create');
  if (o.dataAs === 'inserts') args.push('--inserts');
  if (o.dataAs === 'column-inserts') args.push('--column-inserts');
  if (o.compression != null && o.format !== 'tar') args.push('-Z', String(Math.max(0, Math.min(9, Math.floor(o.compression)))));
  if (o.scope === 'schemas') for (const s of o.schemas) args.push('-n', quoteIdent(s));
  if (o.scope === 'tables') for (const t of o.tables) args.push('-t', qualifiedPattern(t));
  for (const t of o.excludeTableData ?? []) args.push('--exclude-table-data', qualifiedPattern(t));

  const scopeNote =
    o.scope === 'database' ? 'Whole database' : o.scope === 'schemas' ? `Schemas: ${o.schemas.join(', ')}` : `${o.tables.length} table${o.tables.length === 1 ? '' : 's'}`;
  const note = [scopeNote, o.schemaOnly && 'schema only', o.dataOnly && 'data only', o.excludeTableData?.length && `${o.excludeTableData.length} without data`]
    .filter(Boolean).join(' · ');

  // Estimate progress: count tables whose data will be dumped.
  let totalTables = 0;
  if (!o.schemaOnly) {
    try {
      const [r] = await queryRows<{ n: number }>(conn.id, db, `
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','m')
           AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
           AND ($1::text[] IS NULL OR n.nspname = ANY($1))
           AND ($2::text[] IS NULL OR (n.nspname || '.' || c.relname) = ANY($2) OR (c.relispartition AND EXISTS (
                 SELECT 1 FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = p.relnamespace
                  WHERE i.inhrelid = c.oid AND (pn.nspname || '.' || p.relname) = ANY($2))))`,
        [o.scope === 'schemas' ? o.schemas : null, o.scope === 'tables' ? o.tables : null]);
      totalTables = Math.max(0, r.n - (o.excludeTableData?.length ?? 0));
    } catch { /* progress just stays indeterminate */ }
  }
  let dumped = 0;
  job.info.command = displayCommand(pgDump, args);
  job.info.progressLabel = 'Reading catalog…';

  const timer = setInterval(async () => {
    job.info.bytes = await sizeOf(o.format === 'directory' ? tmpDir : out);
    job.info.durationMs = Date.now() - job.t0;
  }, 500);

  void (async () => {
    let code = await run(job, pgDump, args, pgEnv(conn), {
      onLine: (l) => {
        const m = /dumping contents of table "?([^"]+)"?/.exec(l);
        if (m) {
          dumped++;
          job.info.progressLabel = `Dumping ${m[1]}`;
          if (totalTables) job.info.progress = Math.min(0.97, dumped / totalTables);
        } else if (/reading|identifying|finding|flagging|saving/.test(l) && !dumped) {
          job.info.progressLabel = l.replace(/^pg_dump:\s*/, '');
        }
      },
    });
    if (code === 0 && o.format === 'directory' && !job.canceled) {
      job.info.progressLabel = 'Packing directory into a tar archive…';
      code = await runTar(job, ['-cf', out, '-C', tmpDir, '.']);
    }
    clearInterval(timer);
    if (o.format === 'directory') job.cleanup.push(tmpDir);
    if (code !== 0 || job.canceled) job.cleanup.push(out);
    else {
      updateIndex((idx) => {
        idx[name] = { database: db, connName: conn.name, note, format: job.info.format, createdAt: new Date().toISOString() };
      });
    }
    finish(job, code);
    job.info.bytes = code === 0 && !job.canceled ? await sizeOf(out) : job.info.bytes;
    job.info.progressLabel = job.info.status === 'success' ? 'Backup complete' : job.info.status === 'canceled' ? 'Canceled' : 'Backup failed';
    job.info.summary = { message: job.info.status === 'success' ? `${name} written` : job.info.progressLabel, sizeBytes: job.info.bytes };
    log(job, job.info.status === 'success' ? 'info' : 'error', `— ${job.info.progressLabel} (exit code ${code})`, false);
  })();
  return job.info;
}

// ------------------------------------------------------------------ restore

async function startRestore(conn: ConnectionConfig, o: RestoreOptions): Promise<JobInfo> {
  const file = filePath(o.file);
  if (!fs.existsSync(file)) throw new HttpError(404, `Backup ${o.file} not found`);
  const target = String(o.targetDb || '').trim();
  if (!target) throw new HttpError(400, 'Choose a target database');
  const format = await detectFormat(file);
  if (format === 'unknown') throw new HttpError(400, 'Unrecognised backup format (expected pg_dump custom/tar/directory archive or SQL)');
  const tools = await detectTools(conn.id);
  const plain = format === 'plain' || format === 'plain-gz';
  const bin = plain ? tools.binaries.psql.path : tools.binaries.pg_restore.path;
  if (!bin) throw new HttpError(400, tools.message ?? `${plain ? 'psql' : 'pg_restore'} not found`);

  const size = (await fsp.stat(file)).size;
  if (o.createDb) {
    const exists = await queryRows(conn.id, undefined, 'SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (exists.length) throw new HttpError(400, `Database "${target}" already exists`);
  }

  const job = newJob('restore', conn, target, o.file, format, size);
  const env = pgEnv(conn);

  void (async () => {
    let code = 0;
    try {
      if (o.createDb) {
        log(job, 'cmd', `CREATE DATABASE ${quoteIdent(target)} TEMPLATE template0`);
        try {
          await queryRows(conn.id, undefined, `CREATE DATABASE ${quoteIdent(target)} TEMPLATE template0`);
          log(job, 'info', `Created database ${target}`);
        } catch (e: any) {
          log(job, 'error', `ERROR: ${e.message}`);
          finish(job, 1);
          job.info.progressLabel = 'Restore failed';
          return;
        }
      }

      if (plain) {
        const args = ['-X', '-v', `ON_ERROR_STOP=${o.exitOnError ? 1 : 0}`, ...connArgs(conn), '-d', target];
        if (o.singleTransaction) args.push('--single-transaction');
        job.info.command = displayCommand(bin, args) + ` < ${o.file}`;
        let read = 0;
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            read += chunk.length;
            job.info.progress = Math.min(0.99, read / size);
            cb(null, chunk);
          },
        });
        const src = fs.createReadStream(file).pipe(counter);
        const stdin: Readable = format === 'plain-gz' ? src.pipe(zlib.createGunzip()) : src;
        job.info.progressLabel = 'Executing SQL…';
        let inserts = 0;
        code = await run(job, bin, args, env, {
          stdin,
          // INSERT-style dumps print one "INSERT 0 1" per row: count them instead of logging each
          skip: (l) => /^INSERT \d+ \d+$/.test(l),
          onLine: (l) => {
            if (/^INSERT \d+ \d+$/.test(l)) {
              inserts++;
              if (inserts % 1000 === 0) job.info.progressLabel = `${inserts.toLocaleString('en-US')} rows inserted`;
              return;
            }
            const m = /^(CREATE \w+|ALTER \w+|COPY \d+)/.exec(l);
            if (m) job.info.progressLabel = m[1];
          },
        });
        if (inserts) log(job, 'info', `${inserts.toLocaleString('en-US')} INSERT statements executed`);
      } else {
        let src = file;
        if (format === 'directory') {
          const dir = path.join(BACKUP_DIR, `.tmp-${job.info.id}`);
          fs.mkdirSync(dir, { recursive: true });
          job.cleanup.push(dir);
          job.info.progressLabel = 'Unpacking archive…';
          code = await runTar(job, ['-xf', file, '-C', dir]);
          if (code !== 0) throw new Error('Could not unpack the directory archive');
          src = dir;
        }
        // total TOC entries → progress estimate
        let total = 0;
        await new Promise<void>((resolve) => {
          execFile(bin, ['-l', src], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
            if (!err) total = out.split('\n').filter((l) => l && !l.startsWith(';')).length;
            resolve();
          });
        });
        const args = ['--verbose', ...connArgs(conn), '-d', target];
        if (o.clean && !o.dataOnly) args.push('--clean', '--if-exists');
        if (o.noOwner) args.push('--no-owner');
        if (o.noPrivileges) args.push('--no-privileges');
        if (o.dataOnly) args.push('--data-only');
        if (o.schemaOnly) args.push('--schema-only');
        if (o.exitOnError) args.push('--exit-on-error');
        const parallel = o.jobs > 1 && !o.singleTransaction && format !== 'tar';
        if (o.singleTransaction) args.push('--single-transaction');
        if (parallel) args.push('-j', String(Math.min(16, Math.floor(o.jobs))));
        args.push(src);
        job.info.command = displayCommand(bin, args);
        let done = 0;
        job.info.progressLabel = 'Restoring…';
        code = await run(job, bin, args, env, {
          onLine: (l) => {
            const m = /^pg_restore: (creating|processing data for|executing|processing item|launching item)\s+(.*)$/.exec(l);
            if (m) {
              done++;
              job.info.progressLabel = `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}`;
              if (total) job.info.progress = Math.min(0.99, done / total);
            }
          },
        });
      }
    } catch (e: any) {
      log(job, 'error', e.message ?? String(e));
      if (!code) code = 1;
    }

    finish(job, code);
    job.info.durationMs = Date.now() - job.t0;
    const ignored = job.lines.map((l) => /errors ignored on restore: (\d+)/.exec(l.text)).find(Boolean);
    job.info.progressLabel = job.info.status === 'success' ? 'Restore complete' : job.info.status === 'canceled' ? 'Canceled' : 'Restore finished with errors';
    try {
      // one-off client: a pooled connection would linger and block e.g. DROP DATABASE afterwards
      const [s] = await oneOffQuery<{ tables: number; rows: string; size: string }>(conn, target, `
        SELECT count(*)::int AS tables, COALESCE(sum(GREATEST(c.reltuples,0)),0)::bigint AS rows, pg_database_size(current_database()) AS size
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`);
      job.info.summary = {
        tables: s.tables,
        rows: Number(s.rows),
        sizeBytes: Number(s.size),
        message:
          job.info.status === 'success'
            ? `Restored into ${target}`
            : job.info.status === 'canceled'
              ? `Canceled — "${target}" may be partially restored`
              : ignored
              ? `${ignored[1]} error(s) were ignored during restore`
              : `${job.info.errors.length} error(s) — see log`,
      };
    } catch {
      job.info.summary = { message: job.info.progressLabel };
    }
    log(job, job.info.status === 'success' ? 'info' : 'error', `— ${job.info.progressLabel} (exit code ${code})`, false);
  })();
  return job.info;
}

async function oneOffQuery<T>(conn: ConnectionConfig, db: string, sql: string): Promise<T[]> {
  const client = await connectClient(conn, db);
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end().catch(() => {});
  }
}

// ------------------------------------------------------------------ routes

function requireConn(connId: string): ConnectionConfig {
  const c = getConnectionWithSecret(connId);
  if (!c) throw new HttpError(404, `Unknown connection ${connId}`);
  return c;
}

export default async function backupRoutes(app: FastifyInstance) {
  // Raw uploads: stream straight to disk (no body size limit / buffering).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get<{ Querystring: { connId?: string; refresh?: string } }>('/api/backup/tools', async (req) => {
    if (req.query.refresh === '1') candCache = null;
    return detectTools(req.query.connId || null);
  });

  app.put<{ Body: { binDir: string | null } }>('/api/backup/settings', async (req) => {
    const dir = req.body?.binDir?.trim() || null;
    if (dir) {
      const p = path.join(dir, 'pg_dump' + EXE);
      if (!exists(p)) throw new HttpError(400, `No pg_dump in ${dir}`);
      if (!(await versionOf(p))) throw new HttpError(400, `${p} does not run`);
    }
    writeJson(SETTINGS_FILE, { ...settings(), binDir: dir });
    candCache = null;
    return { ok: true };
  });

  app.get<{ Params: { connId: string; db: string } }>('/api/c/:connId/db/:db/backup/tree', async (req): Promise<BackupTreeSchema[]> => {
    const rows = await queryRows<{ schema: string; name: string; kind: string; estRows: number | null; sizeBytes: string | null }>(req.params.connId, req.params.db, `
      SELECT n.nspname AS schema, c.relname AS name,
             CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view'
                            WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' END AS kind,
             CASE WHEN c.relkind IN ('r','m') THEN GREATEST(c.reltuples,0)::float8 END AS "estRows",
             CASE WHEN c.relkind IN ('r','m') THEN pg_total_relation_size(c.oid) END AS "sizeBytes"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype IN ('e','a','i')
       WHERE c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition AND d.objid IS NULL
         AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
       ORDER BY n.nspname = 'public' DESC, n.nspname, c.relkind = 'S', c.relname`);
    const schemas = await queryRows<{ name: string }>(req.params.connId, req.params.db, `
      SELECT n.nspname AS name FROM pg_namespace n LEFT JOIN pg_depend d ON d.objid = n.oid AND d.deptype = 'e'
       WHERE d.objid IS NULL AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
       ORDER BY n.nspname = 'public' DESC, n.nspname`);
    const map = new Map<string, BackupTreeSchema>(schemas.map((s) => [s.name, { name: s.name, tables: [] }]));
    for (const r of rows) {
      let s = map.get(r.schema);
      if (!s) map.set(r.schema, (s = { name: r.schema, tables: [] }));
      s.tables.push({ name: r.name, kind: r.kind as any, estRows: r.estRows, sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes) });
    }
    return [...map.values()];
  });

  app.post<{ Params: { connId: string; db: string }; Body: BackupOptions }>('/api/c/:connId/db/:db/backup', async (req) => {
    return startBackup(requireConn(req.params.connId), req.params.db, req.body);
  });

  app.post<{ Params: { connId: string }; Body: RestoreOptions }>('/api/c/:connId/restore', async (req) => {
    return startRestore(requireConn(req.params.connId), req.body);
  });

  app.get('/api/backup/jobs', async () => [...jobs.values()].map((j) => j.info).reverse());

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>('/api/backup/jobs/:id', async (req): Promise<JobLogResponse> => {
    const job = jobs.get(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    const since = Math.max(Number(req.query.since) || 0, job.base);
    if (job.info.status === 'running') job.info.durationMs = Date.now() - job.t0;
    return { job: job.info, lines: job.lines.slice(since - job.base), next: job.base + job.lines.length };
  });

  app.post<{ Params: { id: string } }>('/api/backup/jobs/:id/cancel', async (req) => {
    const job = jobs.get(req.params.id);
    if (!job) throw new HttpError(404, 'Job not found');
    cancelJob(job);
    return { ok: true };
  });

  app.get('/api/backup/files', async () => listFiles());

  app.get<{ Params: { name: string } }>('/api/backup/files/:name/download', async (req, reply) => {
    const p = filePath(req.params.name);
    if (!fs.existsSync(p)) throw new HttpError(404, 'File not found');
    const st = await fsp.stat(p);
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(st.size))
      .header('content-disposition', `attachment; filename="${req.params.name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(req.params.name)}`);
    return reply.send(fs.createReadStream(p));
  });

  app.delete<{ Params: { name: string } }>('/api/backup/files/:name', async (req) => {
    const name = safeName(req.params.name);
    if ([...jobs.values()].some((j) => j.info.status === 'running' && j.info.file === name)) throw new HttpError(409, 'File is in use by a running job');
    await fsp.rm(filePath(name), { force: true });
    updateIndex((idx) => { delete idx[name]; });
    return { ok: true };
  });

  app.post<{ Querystring: { name?: string } }>('/api/backup/upload', async (req): Promise<BackupFile> => {
    const original = path.basename(String(req.query.name || 'upload.sql'));
    const ext = /\.(sql\.gz|dir\.tar|sql|dump|backup|tar|gz|pgdump)$/i.exec(original)?.[0] ?? '';
    const stem = sanitizeStem(ext ? original.slice(0, -ext.length) : original);
    const name = uniqueName(stem, ext.toLowerCase());
    const dest = path.join(BACKUP_DIR, name);
    try {
      await pipeline(req.body as Readable, fs.createWriteStream(dest, { mode: 0o600 }));
    } catch (e) {
      fs.rmSync(dest, { force: true });
      throw e;
    }
    const st = await fsp.stat(dest);
    const format = await detectFormat(dest);
    if (format === 'unknown') {
      fs.rmSync(dest, { force: true });
      throw new HttpError(400, 'Unrecognised file: expected a pg_dump archive (.dump / .tar) or a SQL script (.sql / .sql.gz)');
    }
    updateIndex((idx) => {
      idx[name] = { database: '', connName: '', note: `Uploaded (${original})`, format, createdAt: new Date().toISOString() };
    });
    return { name, size: st.size, modifiedAt: st.mtime.toISOString(), format, database: null, connName: null, note: `Uploaded (${original})` };
  });
}
