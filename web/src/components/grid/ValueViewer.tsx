import { AlertCircle, Check, Copy, WrapText } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Dialog, IconButton, Segmented, Spinner, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { modKey } from '@/lib/format';
import {
  byteaKind, byteaLength, cellToText, formatByteSize, isArrayType, isByteaType, isDefaultMarker, isJsonType, parsePgArray,
} from './cell';
import { copyText } from './export';
import type { CellValue } from './types';

const JsonCodeEditor = lazy(() => import('./JsonCodeEditor'));

export interface ValueViewerProps {
  open: boolean;
  onClose: () => void;
  value: CellValue;
  columnName: string;
  typeName?: string;
  /** Full type for display (e.g. "character varying(32)"). */
  typeLabel?: string;
  rowLabel?: string;
  /** Provide to make the viewer an editor. */
  onSave?: (v: CellValue) => void;
  nullable?: boolean;
  /** Start in edit mode (otherwise read-only until the user clicks Edit). */
  startEditing?: boolean;
}

type View = 'text' | 'json' | 'hex' | 'utf8' | 'image' | 'list';

function hexToBytes(hex: string, max = Infinity): Uint8Array {
  const h = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const n = Math.min(h.length / 2, max);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.subarray(off, off + 16);
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function prettyJson(s: string): { text: string; ok: boolean } {
  try { return { text: JSON.stringify(JSON.parse(s), null, 2), ok: true }; } catch { return { text: s, ok: false }; }
}

/**
 * Modal value inspector / editor for a single cell: pretty JSON (Monaco), arrays as lists,
 * bytea as hex dump / UTF-8 / image preview, long text with wrapping. NULL vs empty string
 * are always explicit.
 */
export function ValueViewer(props: ValueViewerProps) {
  const { open, onClose, value, columnName, typeName, typeLabel, rowLabel, onSave, nullable = true } = props;
  const editable = !!onSave;
  const raw = isDefaultMarker(value) ? '' : value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const json = isJsonType(typeName);
  const bytea = isByteaType(typeName) && raw?.startsWith('\\x');
  const arr = isArrayType(typeName) && raw != null ? parsePgArray(raw) : null;

  const views = useMemo(() => {
    const v: { value: View; label: string }[] = [];
    if (json) v.push({ value: 'json', label: 'JSON' });
    if (arr) v.push({ value: 'list', label: `List (${arr.length})` });
    if (bytea) {
      v.push({ value: 'hex', label: 'Hex' }, { value: 'utf8', label: 'UTF-8' });
      if (raw && byteaKind(raw)?.mime.startsWith('image/')) v.unshift({ value: 'image', label: 'Image' });
    }
    v.push({ value: 'text', label: json || bytea || arr ? 'Raw' : 'Text' });
    return v;
  }, [json, arr, bytea, raw]);

  const [view, setView] = useState<View>(views[0].value);
  const [editing, setEditing] = useState(!!props.startEditing && editable);
  const [draft, setDraft] = useState('');
  const [draftNull, setDraftNull] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setView(views[0].value);
    setEditing(!!props.startEditing && editable);
    setDraftNull(raw === null);
    setDraft(raw === null ? '' : json ? prettyJson(raw).text : raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, raw]);

  const jsonError = useMemo(() => {
    if (!editing || !json || draftNull) return null;
    try { JSON.parse(draft); return null; } catch (e) { return (e as Error).message; }
  }, [editing, json, draft, draftNull]);

  const save = () => {
    if (!onSave || jsonError) return;
    if (draftNull) onSave(null);
    else if (json) {
      // keep the user's formatting minimal: store compact JSON (jsonb normalizes anyway)
      try { onSave(JSON.stringify(JSON.parse(draft))); } catch { return; }
    } else onSave(draft);
    onClose();
  };

  const copy = async () => {
    await copyText(editing ? draft : json && raw ? prettyJson(raw).text : cellToText(value, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const stats = useMemo(() => {
    const t = editing ? (draftNull ? null : draft) : raw;
    if (t === null) return 'NULL';
    if (bytea && t.startsWith('\\x')) return formatByteSize(byteaLength(t));
    const lines = t.split('\n').length;
    return `${t.length.toLocaleString()} chars${lines > 1 ? ` · ${lines} lines` : ''}`;
  }, [raw, bytea, editing, draft, draftNull]);

  const bytes = useMemo(() => (bytea && raw && !editing && (view === 'hex' || view === 'utf8' || view === 'image') ? hexToBytes(raw, view === 'image' ? Infinity : 256 * 1024) : null), [bytea, raw, view, editing]);

  let body: React.ReactNode;
  if (editing) {
    body = draftNull ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong text-sm text-null">
        <span className="italic">NULL</span>
        <Button size="xs" variant="ghost" onClick={() => setDraftNull(false)}>Enter a value instead</Button>
      </div>
    ) : json ? (
      <div className="h-full overflow-hidden rounded-md border border-border-strong">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
          <JsonCodeEditor value={draft} onChange={setDraft} onSubmit={save} />
        </Suspense>
      </div>
    ) : (
      <Textarea
        autoFocus
        mono
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
        }}
        className={cn('h-full resize-none text-[12.5px] leading-relaxed', !wrap && 'whitespace-pre')}
        wrap={wrap ? 'soft' : 'off'}
        placeholder={bytea ? '\\x0123abcd…' : 'Empty string'}
      />
    );
  } else if (raw === null) {
    body = <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border-strong text-sm text-null italic">NULL</div>;
  } else if (view === 'json') {
    body = (
      <div className="h-full overflow-hidden rounded-md border border-border">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
          <JsonCodeEditor value={prettyJson(raw).text} readOnly />
        </Suspense>
      </div>
    );
  } else if (view === 'list' && arr) {
    body = (
      <div className="h-full overflow-auto rounded-md border border-border">
        <table className="w-full text-[12.5px]">
          <tbody>
            {arr.map((el, i) => (
              <tr key={i} className="border-b border-grid-line last:border-0 odd:bg-grid-alt">
                <td className="w-12 px-2 py-1 text-right text-[11px] text-subtle tabular-nums">{i + 1}</td>
                <td className="px-2 py-1 font-mono break-all">
                  {el === null ? <span className="text-null italic">NULL</span> : el === '' ? <span className="text-[10px] text-subtle">EMPTY</span> : el}
                </td>
              </tr>
            ))}
            {!arr.length && <tr><td className="p-4 text-center text-xs text-subtle">Empty array</td></tr>}
          </tbody>
        </table>
      </div>
    );
  } else if (view === 'hex' && bytes) {
    body = (
      <pre className="h-full overflow-auto rounded-md border border-border bg-sunken p-3 font-mono text-[11.5px] leading-relaxed text-fg">
        {hexDump(bytes)}
        {byteaLength(raw) > bytes.length && <span className="text-subtle">{`\n… ${formatByteSize(byteaLength(raw) - bytes.length)} more`}</span>}
      </pre>
    );
  } else if (view === 'utf8' && bytes) {
    body = (
      <pre className="h-full overflow-auto rounded-md border border-border bg-sunken p-3 font-mono text-[12px] whitespace-pre-wrap break-all text-fg">
        {new TextDecoder('utf-8', { fatal: false }).decode(bytes)}
      </pre>
    );
  } else if (view === 'image' && bytes) {
    const mime = byteaKind(raw)!.mime;
    body = (
      <div className="flex h-full items-center justify-center overflow-auto rounded-md border border-border bg-[repeating-conic-gradient(var(--sunken)_0_25%,var(--bg)_0_50%)] bg-[length:16px_16px] p-4">
        <img alt={columnName} src={`data:${mime};base64,${bytesToBase64(bytes)}`} className="max-h-full max-w-full object-contain shadow-sm" />
      </div>
    );
  } else {
    body = raw === '' ? (
      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border-strong text-sm text-subtle">Empty string ('')</div>
    ) : (
      <pre className={cn('h-full overflow-auto rounded-md border border-border bg-sunken p-3 font-mono text-[12.5px] leading-relaxed text-fg select-text', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
        {raw}
      </pre>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={780}
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{columnName}</span>
          {(typeLabel || typeName) && <Badge>{typeLabel || typeName}</Badge>}
          {editing && <Badge tone="accent">editing</Badge>}
        </span>
      }
      description={rowLabel}
      footer={
        <>
          <span className="mr-auto text-[11px] text-subtle tabular-nums">{stats}</span>
          {editing ? (
            <>
              {nullable && !draftNull && <Button variant="ghost" onClick={() => setDraftNull(true)}>Set NULL</Button>}
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={!!jsonError}>
                Apply <span className="opacity-60">{modKey}↵</span>
              </Button>
            </>
          ) : (
            <>
              {editable && <Button variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
              <Button variant="primary" onClick={onClose} autoFocus>Close</Button>
            </>
          )}
        </>
      }
    >
      <div className="flex h-[min(60vh,560px)] flex-col gap-2">
        <div className="flex items-center gap-2">
          {!editing && views.length > 1 && <Segmented size="xs" value={view} onChange={setView} options={views} />}
          {editing && json && (
            <Button size="xs" variant="ghost" onClick={() => setDraft((d) => prettyJson(d).text)} disabled={!!jsonError || draftNull}>Format</Button>
          )}
          <div className="flex-1" />
          {jsonError && (
            <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-danger"><AlertCircle size={12} className="shrink-0" />{jsonError}</span>
          )}
          {(editing ? !json && !draftNull : raw !== null && (view === 'text' || view === 'utf8')) && (
            <IconButton size="xs" label={wrap ? 'Disable word wrap' : 'Word wrap'} active={wrap} onClick={() => setWrap((w) => !w)}><WrapText size={13} /></IconButton>
          )}
          <IconButton size="xs" label="Copy value" onClick={copy}>{copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}</IconButton>
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    </Dialog>
  );
}
