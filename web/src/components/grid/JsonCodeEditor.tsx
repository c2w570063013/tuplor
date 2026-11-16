import '@/lib/monaco';
import { Editor } from '@monaco-editor/react';
import { useRef } from 'react';
import { monacoTheme } from '@/lib/monaco';
import { useResolvedTheme, useSettings } from '@/stores/settings';

/** Monaco-based JSON / text editor used by the value viewer (lazy loaded). */
export default function JsonCodeEditor({
  value, onChange, readOnly, language = 'json', onSubmit,
}: { value: string; onChange?: (v: string) => void; readOnly?: boolean; language?: string; onSubmit?: () => void }) {
  const theme = useResolvedTheme();
  const fontSize = useSettings((s) => s.editorFontSize);
  // Monaco commands are registered once on mount: always call the latest callback.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  return (
    <Editor
      value={value}
      language={language}
      theme={monacoTheme(theme)}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={(ed, monaco) => {
        if (!readOnly) ed.focus();
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submitRef.current?.());
      }}
      options={{
        readOnly,
        fontSize,
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        automaticLayout: true,
        folding: true,
        renderLineHighlight: readOnly ? 'none' : 'line',
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        fixedOverflowWidgets: true,
      }}
    />
  );
}
