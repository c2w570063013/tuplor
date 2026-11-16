import { Copy, Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';

const KEYWORDS = new Set(
  ('select from where and or not insert into values update set delete create alter drop table view index on as join left right inner outer full ' +
    'cross group by order having limit offset returning with recursive union all distinct case when then else end is null true false primary key ' +
    'foreign references unique check default constraint add column rename to type cascade restrict if exists begin commit rollback grant revoke ' +
    'function procedure returns language trigger before after for each row execute schema sequence materialized database role user owner ' +
    'in like ilike between asc desc nulls first last using only replace temporary temp unlogged partition of comment extension analyze explain ' +
    'vacuum concurrently do declare return plpgsql sql immutable stable volatile security definer invoker strict window over lateral generated always identity stored').split(' '),
);

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$)|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Tokenize SQL into highlighted spans (lightweight; for read-only previews). */
export function highlightSql(sql: string) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(sql))) {
    if (m.index > last) out.push(sql.slice(last, m.index));
    const [tok, comment, str, ident, dollar, num, word] = m;
    let cls = '';
    if (comment) cls = 'text-subtle italic';
    else if (str || dollar) cls = 'text-syntax-string';
    else if (ident) cls = 'text-fg';
    else if (num) cls = 'text-syntax-number';
    else if (word && KEYWORDS.has(word.toLowerCase())) cls = 'text-syntax-keyword font-medium';
    out.push(cls ? <span key={i++} className={cls}>{tok}</span> : tok);
    last = m.index + tok.length;
  }
  if (last < sql.length) out.push(sql.slice(last));
  return out;
}

export function SqlBlock({ sql, className, copyable = true }: { sql: string; className?: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const nodes = useMemo(() => highlightSql(sql), [sql]);
  return (
    <div className={cn('group relative overflow-auto rounded-lg border border-border bg-sunken', className)}>
      {copyable && (
        <button
          onClick={() => {
            navigator.clipboard.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="absolute top-2 right-2 rounded-md border border-border bg-elevated p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg"
          aria-label="Copy SQL"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
      <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre text-muted">{nodes}</pre>
    </div>
  );
}
