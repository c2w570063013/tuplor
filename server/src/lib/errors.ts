import type { QueryError } from '../../../shared/types';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Convert a pg DatabaseError (or anything) into our QueryError shape. */
export function toQueryError(e: any): QueryError {
  if (!e) return { message: 'Unknown error' };
  const err: QueryError = { message: e.message || String(e) };
  if (e.code) err.code = e.code;
  if (e.detail) err.detail = e.detail;
  if (e.hint) err.hint = e.hint;
  if (e.position) err.position = Number(e.position);
  if (e.where) err.where = e.where;
  if (e.severity) err.severity = e.severity;
  if (e.code === 'ECONNREFUSED') err.message = `Connection refused (${e.address}:${e.port}). Is the server running?`;
  if (e.code === 'ENOTFOUND') err.message = `Host not found: ${e.hostname}`;
  return err;
}
