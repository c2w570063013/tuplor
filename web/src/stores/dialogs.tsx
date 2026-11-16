import { create } from 'zustand';
import { useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Dialog } from '@/components/ui';
import { SqlBlock } from '@/components/SqlBlock';

/**
 * Imperative dialogs usable from anywhere:
 *   if (await confirm({ title: 'Drop table?', message: '…', danger: true })) …
 *   if (await confirmSql({ title: 'Apply changes', sql })) …   // shows SQL preview
 *   const name = await prompt({ title: 'Rename', defaultValue: 'x' });
 */
type Req =
  | { type: 'confirm'; title: string; message?: ReactNode; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void }
  | { type: 'sql'; title: string; message?: ReactNode; sql: string; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void }
  | { type: 'prompt'; title: string; message?: ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string; resolve: (v: string | null) => void };

const useDialogs = create<{ queue: Req[]; push: (r: Req) => void; pop: () => void }>((set) => ({
  queue: [],
  push: (r) => set((s) => ({ queue: [...s.queue, r] })),
  pop: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

export function confirm(o: { title: string; message?: ReactNode; danger?: boolean; confirmLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().push({ type: 'confirm', ...o, resolve }));
}
export function confirmSql(o: { title: string; sql: string; message?: ReactNode; danger?: boolean; confirmLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().push({ type: 'sql', ...o, resolve }));
}
export function prompt(o: { title: string; message?: ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().push({ type: 'prompt', ...o, resolve }));
}

export function DialogHost() {
  const req = useDialogs((s) => s.queue[0]);
  const pop = useDialogs((s) => s.pop);
  const [value, setValue] = useState<string | null>(null);
  if (!req) return null;
  const done = (v: any) => {
    (req.resolve as (x: any) => void)(v);
    setValue(null);
    pop();
  };
  const cancelValue = req.type === 'prompt' ? null : false;
  const current = value ?? (req.type === 'prompt' ? req.defaultValue ?? '' : '');
  const submit = () => done(req.type === 'prompt' ? current : true);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && done(cancelValue)}
      title={req.title}
      width={req.type === 'sql' ? 680 : 440}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(cancelValue)}>Cancel</Button>
          <Button variant={'danger' in req && req.danger ? 'danger' : 'primary'} onClick={submit} autoFocus={req.type !== 'prompt'}>
            {req.confirmLabel ?? (req.type === 'sql' ? 'Execute' : 'OK')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {req.message && (
          <div className="flex gap-2.5 text-[13px] text-muted">
            {'danger' in req && req.danger && <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />}
            <div>{req.message}</div>
          </div>
        )}
        {req.type === 'sql' && <SqlBlock sql={req.sql} className="max-h-[50vh]" />}
        {req.type === 'prompt' && (
          <input
            autoFocus
            className="h-8 w-full rounded-md border border-border-strong bg-bg px-2.5 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
            value={current}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        )}
      </div>
    </Dialog>
  );
}
