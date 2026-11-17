import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ConnectionConfig } from '../../shared/types';
import { dataFile, readJson, writeJson } from './lib/paths';

/**
 * Connection store: ~/.tuplor/connections.json.
 * Passwords are encrypted with AES-256-GCM using a per-install key in ~/.tuplor/secret.key.
 */

interface StoredConnection extends Omit<ConnectionConfig, 'password' | 'hasPassword'> {
  passwordEnc?: string;
}

const FILE = 'connections.json';

function key(): Buffer {
  const file = dataFile('secret.key');
  try {
    const k = fs.readFileSync(file);
    if (k.length === 32) return k;
  } catch { /* create below */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k, { mode: 0o600 });
  return k;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function load(): StoredConnection[] {
  return readJson<StoredConnection[]>(FILE, []);
}

function save(list: StoredConnection[]) {
  writeJson(FILE, list);
}

function toPublic(c: StoredConnection): ConnectionConfig {
  const { passwordEnc, ...rest } = c;
  return { ...rest, hasPassword: !!passwordEnc };
}

export function listConnections(): ConnectionConfig[] {
  return load().map(toPublic);
}

export function getConnection(id: string): ConnectionConfig | undefined {
  const c = load().find((x) => x.id === id);
  return c && toPublic(c);
}

/** Full config including decrypted password — server-side use only. */
export function getConnectionWithSecret(id: string): ConnectionConfig | undefined {
  const c = load().find((x) => x.id === id);
  if (!c) return undefined;
  let password: string | undefined;
  if (c.passwordEnc) {
    try { password = decrypt(c.passwordEnc); } catch { password = undefined; }
  }
  return { ...toPublic(c), password };
}

export function saveConnection(input: ConnectionConfig): ConnectionConfig {
  const list = load();
  const now = new Date().toISOString();
  const idx = list.findIndex((x) => x.id === input.id);
  const { password, hasPassword, ...rest } = input;
  const prev = idx >= 0 ? list[idx] : undefined;
  let passwordEnc = prev?.passwordEnc;
  if (password !== undefined) passwordEnc = password === '' ? undefined : encrypt(password);
  const stored: StoredConnection = {
    ...rest,
    id: input.id || crypto.randomUUID(),
    passwordEnc,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  if (idx >= 0) list[idx] = stored;
  else list.push(stored);
  save(list);
  return toPublic(stored);
}

export function deleteConnection(id: string): boolean {
  const list = load();
  const next = list.filter((x) => x.id !== id);
  save(next);
  return next.length !== list.length;
}
