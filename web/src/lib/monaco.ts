/**
 * Monaco bootstrap: bundle Monaco locally (no CDN; works offline) and define themes.
 * Import `{ Editor }` from '@monaco-editor/react' anywhere after importing this module once.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';

(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('pgstudio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c4b5fd', fontStyle: 'bold' },
    { token: 'string', foreground: '86efac' },
    { token: 'number', foreground: 'fdba74' },
    { token: 'comment', foreground: '6f6f7b', fontStyle: 'italic' },
    { token: 'operator', foreground: 'a3a3ae' },
    { token: 'predefined', foreground: '7dd3fc' },
    { token: 'identifier.quote', foreground: 'e8e8ec' },
  ],
  colors: {
    'editor.background': '#121316',
    'editor.lineHighlightBackground': '#1a1b20',
    'editorLineNumber.foreground': '#4a4b55',
    'editorLineNumber.activeForeground': '#a3a3ae',
    'editor.selectionBackground': '#6b85ff40',
    'editorCursor.foreground': '#8198ff',
    'editorWidget.background': '#202126',
    'editorWidget.border': '#2a2b31',
    'editorSuggestWidget.background': '#202126',
    'editorSuggestWidget.border': '#2a2b31',
    'editorSuggestWidget.selectedBackground': '#6b85ff33',
    'editorGutter.background': '#121316',
    'scrollbarSlider.background': '#3a3b4366',
  },
});

monaco.editor.defineTheme('pgstudio-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
    { token: 'string', foreground: '0a7d32' },
    { token: 'number', foreground: 'b45309' },
    { token: 'comment', foreground: '8e8e99', fontStyle: 'italic' },
    { token: 'predefined', foreground: '0369a1' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f7f7f8',
    'editorLineNumber.foreground': '#c4c4cc',
    'editorLineNumber.activeForeground': '#5b5b66',
    'editor.selectionBackground': '#4f6ef733',
  },
});

loader.config({ monaco });

export const monacoTheme = (t: 'dark' | 'light') => (t === 'dark' ? 'pgstudio-dark' : 'pgstudio-light');
export { monaco };
