import { AlertCircle, Crown, RefreshCw, Settings2, User, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RoleInfo } from '@shared/roles';
import { Badge, Button, Spinner, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorInfo } from './api';

/** Icon for a role: crown = superuser, person = login role, people = group role, gear = built-in. */
export function RoleIcon({ role, size = 14, className }: { role: RoleInfo; size?: number; className?: string }) {
  if (role.isSystem) return <Settings2 size={size} className={cn('shrink-0 text-subtle', className)} />;
  if (role.superuser) return <Crown size={size} className={cn('shrink-0 text-warning', className)} />;
  if (role.canLogin) return <User size={size} className={cn('shrink-0 text-accent', className)} />;
  return <Users size={size} className={cn('shrink-0 text-info', className)} />;
}

export function roleKindLabel(role: RoleInfo): string {
  if (role.isSystem) return 'Built-in role';
  if (role.superuser) return role.canLogin ? 'Superuser' : 'Superuser group';
  return role.canLogin ? 'Login role' : 'Group role';
}

export interface ExpiryInfo {
  text: string;
  expired: boolean;
  never: boolean;
}

export function expiryInfo(v: string | null): ExpiryInfo {
  if (!v || v === 'infinity') return { text: 'Never', expired: false, never: true };
  if (v === '-infinity') return { text: 'Expired', expired: true, never: false };
  const d = new Date(v);
  if (isNaN(d.getTime())) return { text: v, expired: false, never: false };
  return {
    text: d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    expired: d.getTime() < Date.now(),
    never: false,
  };
}

/** Attribute badges shown in the detail header. */
export function RoleBadges({ role, isYou, compact }: { role: RoleInfo; isYou?: boolean; compact?: boolean }) {
  const exp = expiryInfo(role.validUntil);
  const items: { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; title: string }[] = [];
  if (isYou) items.push({ label: 'You', tone: 'accent', title: 'The role PG Studio is connected as' });
  if (role.superuser) items.push({ label: 'Superuser', tone: 'warning', title: 'Bypasses all permission checks' });
  if (role.canLogin) items.push({ label: 'Login', tone: 'success', title: 'Can log in' });
  if (!compact) {
    if (role.createDb) items.push({ label: 'Create DB', tone: 'neutral', title: 'Can create databases' });
    if (role.createRole) items.push({ label: 'Create role', tone: 'neutral', title: 'Can create, alter and drop roles' });
    if (role.replication) items.push({ label: 'Replication', tone: 'neutral', title: 'Can initiate streaming replication' });
    if (role.bypassRls) items.push({ label: 'Bypass RLS', tone: 'neutral', title: 'Bypasses row-level security policies' });
    if (!role.inherit) items.push({ label: 'No inherit', tone: 'neutral', title: 'Does not inherit privileges of roles it is a member of' });
  }
  if (exp.expired) items.push({ label: 'Expired', tone: 'danger', title: `Password expired ${exp.text}` });
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((b) => (
        <Tooltip key={b.label} content={b.title}>
          <span><Badge tone={b.tone}>{b.label}</Badge></span>
        </Tooltip>
      ))}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex h-full min-h-24 items-center justify-center gap-2 text-xs text-muted', className)}>
      <Spinner size={14} /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const i = errorInfo(error);
  return (
    <div className={cn('flex h-full min-h-24 flex-col items-center justify-center gap-2 p-6 text-center', className)}>
      <AlertCircle size={20} className="text-danger" />
      <div className="text-[13px] font-medium text-fg">{title}</div>
      <div className="max-w-md text-xs break-words text-muted">{i.message}</div>
      {i.hint && <div className="max-w-md text-[11px] text-subtle">{i.hint}</div>}
      {onRetry && (
        <Button size="xs" variant="outline" icon={<RefreshCw size={12} />} onClick={onRetry} className="mt-1">
          Retry
        </Button>
      )}
    </div>
  );
}

/** Inline error box for dialogs. */
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const i = errorInfo(error);
  return (
    <div className="flex gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
      <AlertCircle size={14} className="mt-px shrink-0" />
      <div className="min-w-0 break-words">
        <div className="font-medium">{i.message}</div>
        {i.detail && <div className="mt-0.5 whitespace-pre-wrap opacity-90">{i.detail}</div>}
        {i.hint && <div className="mt-0.5 opacity-90">Hint: {i.hint}</div>}
      </div>
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-7 items-center gap-2', className)}>
      <h3 className="flex-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">{children}</h3>
      {right}
    </div>
  );
}

/** Two-line label used in toggle rows. */
export function OptionLabel({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-[13px] text-fg">{title}</span>
      {description && <span className="text-[11px] leading-snug text-subtle">{description}</span>}
    </span>
  );
}

export const ATTRIBUTES: {
  key: 'canLogin' | 'superuser' | 'createDb' | 'createRole' | 'inherit' | 'replication' | 'bypassRls';
  label: string;
  sql: [string, string];
  description: string;
  superuserOnly?: boolean;
}[] = [
  { key: 'canLogin', label: 'Can log in', sql: ['LOGIN', 'NOLOGIN'], description: 'Role can be used to connect (a "user")' },
  { key: 'superuser', label: 'Superuser', sql: ['SUPERUSER', 'NOSUPERUSER'], description: 'Bypasses all permission checks', superuserOnly: true },
  { key: 'createDb', label: 'Create databases', sql: ['CREATEDB', 'NOCREATEDB'], description: 'Can create new databases' },
  { key: 'createRole', label: 'Create roles', sql: ['CREATEROLE', 'NOCREATEROLE'], description: 'Can create, alter and drop other roles' },
  { key: 'inherit', label: 'Inherit privileges', sql: ['INHERIT', 'NOINHERIT'], description: 'Automatically uses privileges of granted roles' },
  { key: 'replication', label: 'Replication', sql: ['REPLICATION', 'NOREPLICATION'], description: 'Can start streaming replication / backups', superuserOnly: true },
  { key: 'bypassRls', label: 'Bypass RLS', sql: ['BYPASSRLS', 'NOBYPASSRLS'], description: 'Ignores row-level security policies', superuserOnly: true },
];

/** Random password with letters, digits and a few symbols (avoids quotes for easy copy/paste). */
export function generatePassword(len = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%^*+=';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

export function sortRoles(a: RoleInfo, b: RoleInfo) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
