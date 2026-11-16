import { useEffect, useState } from 'react';
import { CheckCircle2, Plug, XCircle } from 'lucide-react';
import { create } from 'zustand';
import type { ConnectionConfig, ConnectionTestResult, SslMode } from '@shared/types';
import { Button, Dialog, Field, Input, Select, Switch, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useConnections } from '@/stores/connections';

export const CONNECTION_COLORS = ['#6b85ff', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#06b6d4', '#64748b'];

const blank = (): ConnectionConfig => ({
  id: '', name: '', host: 'localhost', port: 5432, user: 'postgres', password: '', database: 'postgres',
  sslMode: 'prefer', color: CONNECTION_COLORS[0], group: '', readOnly: false,
});

/** Global open/close state so any component can open the dialog. */
export const useConnectionDialog = create<{ open: boolean; editing: ConnectionConfig | null; show: (c?: ConnectionConfig) => void; hide: () => void }>((set) => ({
  open: false,
  editing: null,
  show: (c) => set({ open: true, editing: c ?? null }),
  hide: () => set({ open: false, editing: null }),
}));

/** Parse postgres://user:pass@host:port/db?sslmode=require */
function parseUrl(url: string): Partial<ConnectionConfig> | null {
  try {
    const u = new URL(url.trim());
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    const ssl = u.searchParams.get('sslmode') as SslMode | null;
    return {
      host: decodeURIComponent(u.hostname) || 'localhost',
      port: u.port ? Number(u.port) : 5432,
      user: decodeURIComponent(u.username) || 'postgres',
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      ...(ssl ? { sslMode: ssl } : {}),
    };
  } catch {
    return null;
  }
}

export function ConnectionDialog() {
  const { open, editing, hide } = useConnectionDialog();
  const save = useConnections((s) => s.save);
  const connect = useConnections((s) => s.connect);
  const [form, setForm] = useState<ConnectionConfig>(blank());
  const [pwTouched, setPwTouched] = useState(false);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (open) {
      setForm(editing ? { ...editing, password: undefined } : blank());
      setPwTouched(false);
      setTest(null);
      setUrl('');
    }
  }, [open, editing]);

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTest(null);
  };

  const payload = (): ConnectionConfig => ({
    ...form,
    name: form.name.trim() || `${form.user}@${form.host}`,
    password: editing && !pwTouched ? undefined : form.password ?? '',
  });

  const doTest = async () => {
    setTesting(true);
    try {
      setTest(await api.testConnection(payload()));
    } catch (e: any) {
      setTest({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const doSave = async (andConnect: boolean) => {
    setSaving(true);
    try {
      const saved = await save(payload());
      hide();
      toast.success(editing ? 'Connection updated' : 'Connection saved');
      if (andConnect) connect(saved.id).catch((e) => toast.error(`Could not connect: ${e.message}`));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && hide()}
      title={editing ? 'Edit connection' : 'New connection'}
      description="Connect to any PostgreSQL server. Passwords are encrypted on this machine."
      width={560}
      footer={
        <>
          <Button variant="outline" icon={<Plug size={13} />} onClick={doTest} loading={testing} className="mr-auto">
            Test connection
          </Button>
          <Button variant="ghost" onClick={hide}>Cancel</Button>
          <Button variant="secondary" onClick={() => doSave(false)} disabled={saving}>Save</Button>
          <Button variant="primary" onClick={() => doSave(true)} loading={saving}>Save & connect</Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-3">
        {!editing && (
          <Field label="Paste a connection URL (optional)" className="col-span-6">
            <Input
              mono
              size="sm"
              placeholder="postgres://user:password@host:5432/database"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                const p = parseUrl(e.target.value);
                if (p) { setForm((f) => ({ ...f, ...p })); setPwTouched(true); setTest(null); }
              }}
            />
          </Field>
        )}
        <Field label="Name" className="col-span-4">
          <Input autoFocus placeholder={`${form.user}@${form.host}`} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Group" className="col-span-2">
          <Input placeholder="e.g. Production" value={form.group ?? ''} onChange={(e) => set('group', e.target.value)} />
        </Field>
        <Field label="Host" hint="Hostname, IP, or a Unix socket directory such as /tmp" className="col-span-4">
          <Input mono value={form.host} onChange={(e) => set('host', e.target.value)} />
        </Field>
        <Field label="Port" className="col-span-2">
          <Input mono type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value) || 5432)} />
        </Field>
        <Field label="User" className="col-span-3">
          <Input mono value={form.user} onChange={(e) => set('user', e.target.value)} />
        </Field>
        <Field label="Password" className="col-span-3">
          <Input
            type="password"
            placeholder={editing?.hasPassword && !pwTouched ? '•••••••• (unchanged)' : ''}
            value={form.password ?? ''}
            onChange={(e) => { setPwTouched(true); set('password', e.target.value); }}
          />
        </Field>
        <Field label="Database" className="col-span-3">
          <Input mono value={form.database} onChange={(e) => set('database', e.target.value)} />
        </Field>
        <Field label="SSL mode" className="col-span-3">
          <Select
            value={form.sslMode}
            onChange={(e) => set('sslMode', e.target.value as SslMode)}
            options={[
              { value: 'disable', label: 'Disable' },
              { value: 'prefer', label: 'Prefer' },
              { value: 'require', label: 'Require' },
              { value: 'verify-ca', label: 'Verify CA' },
              { value: 'verify-full', label: 'Verify full' },
            ]}
          />
        </Field>
        <Field label="Color" className="col-span-4">
          <div className="flex h-8 items-center gap-1.5">
            {CONNECTION_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => set('color', c)}
                className={cn('h-5 w-5 rounded-full ring-offset-2 ring-offset-elevated transition', form.color === c && 'ring-2 ring-fg')}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </Field>
        <Field label="Read-only" className="col-span-2">
          <div className="flex h-8 items-center gap-2">
            <Switch checked={!!form.readOnly} onCheckedChange={(v) => set('readOnly', v)} />
            <span className="text-xs text-muted">Block writes</span>
          </div>
        </Field>
      </div>
      {test && (
        <div
          className={cn(
            'animate-fade-in mt-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs',
            test.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
          )}
        >
          {test.ok ? <CheckCircle2 size={15} className="shrink-0" /> : <XCircle size={15} className="shrink-0" />}
          <div className="min-w-0 break-words">
            {test.ok ? `Connected — PostgreSQL ${test.serverVersion} · ${test.latencyMs} ms` : test.error}
          </div>
        </div>
      )}
    </Dialog>
  );
}
