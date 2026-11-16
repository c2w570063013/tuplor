import type { ReactNode } from 'react';
import { Field, Input, Segmented, Switch } from '@/components/ui';
import { useSettings } from '@/stores/settings';
import type { TabProps } from '../common/TabProps';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border py-3.5">
      <div>
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsTab(_: TabProps) {
  const s = useSettings();
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <h1 className="mb-6 text-xl font-semibold text-fg">Settings</h1>
        <Row label="Theme">
          <Segmented value={s.theme} onChange={(v) => s.set({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
        </Row>
        <Row label="Editor font size">
          <Input type="number" className="w-20" value={s.editorFontSize} onChange={(e) => s.set({ editorFontSize: Number(e.target.value) || 13 })} />
        </Row>
        <Row label="Grid font size">
          <Input type="number" className="w-20" value={s.gridFontSize} onChange={(e) => s.set({ gridFontSize: Number(e.target.value) || 12 })} />
        </Row>
        <Row label="Table page size" hint="Rows loaded per page when browsing a table">
          <Input type="number" className="w-24" value={s.pageSize} onChange={(e) => s.set({ pageSize: Math.max(10, Number(e.target.value) || 200) })} />
        </Row>
        <Row label="Max rows in query results" hint="Results beyond this are truncated (0 = unlimited)">
          <Input type="number" className="w-24" value={s.editorMaxRows} onChange={(e) => s.set({ editorMaxRows: Math.max(0, Number(e.target.value) || 0) })} />
        </Row>
        <Row label="Word wrap in editor">
          <Switch checked={s.wordWrap} onCheckedChange={(v) => s.set({ wordWrap: v })} />
        </Row>
        <Row label="Show system schemas" hint="pg_catalog, information_schema, pg_toast">
          <Switch checked={s.showSystemSchemas} onCheckedChange={(v) => s.set({ showSystemSchemas: v })} />
        </Row>
        <Row label="Confirm dangerous statements" hint="Ask before running DROP / TRUNCATE / DELETE without WHERE">
          <Switch checked={s.confirmDangerous} onCheckedChange={(v) => s.set({ confirmDangerous: v })} />
        </Row>
        <Field label="" className="hidden"><span /></Field>
      </div>
    </div>
  );
}
