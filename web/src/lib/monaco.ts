/**
 * Monaco bootstrap: bundle Monaco locally (no CDN; works offline), define themes and a
 * PostgreSQL language (`PG_LANG`) with a proper tokenizer (dollar quotes, E'' strings,
 * nested comments, ::casts, $1 params, types).
 * Import `{ Editor }` from '@monaco-editor/react' anywhere after importing this module once.
 * (Owned by the SQL Editor team.)
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

/** Language id for PostgreSQL SQL in Monaco. */
export const PG_LANG = 'tuplor-sql';

/** SQL keywords (PostgreSQL). Used for highlighting and completion. */
export const PG_KEYWORDS = (
  'ABORT ABSOLUTE ACCESS ACTION ADD ADMIN AFTER AGGREGATE ALL ALSO ALTER ALWAYS ANALYSE ANALYZE AND ANY ARRAY AS ASC ASSERTION ' +
  'ASSIGNMENT ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTHORIZATION BACKWARD BEFORE BEGIN BETWEEN BINARY BOTH BREADTH BY CACHE CALL CALLED ' +
  'CASCADE CASCADED CASE CAST CATALOG CHAIN CHARACTERISTICS CHECK CHECKPOINT CLASS CLOSE CLUSTER COLLATE COLLATION COLUMN COLUMNS ' +
  'COMMENT COMMENTS COMMIT COMMITTED COMPRESSION CONCURRENTLY CONFIGURATION CONFLICT CONNECTION CONSTRAINT CONSTRAINTS CONTENT ' +
  'CONTINUE CONVERSION COPY COST CREATE CROSS CSV CUBE CURRENT CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_SCHEMA CURRENT_TIME ' +
  'CURRENT_TIMESTAMP CURRENT_USER CURSOR CYCLE DATA DATABASE DAY DEALLOCATE DECLARE DEFAULT DEFAULTS DEFERRABLE DEFERRED DEFINER ' +
  'DELETE DELIMITER DELIMITERS DEPENDS DEPTH DESC DETACH DICTIONARY DISABLE DISCARD DISTINCT DO DOCUMENT DOMAIN DROP EACH ELSE ENABLE ' +
  'ENCODING ENCRYPTED END ENUM ESCAPE EVENT EXCEPT EXCLUDE EXCLUDING EXCLUSIVE EXECUTE EXISTS EXPLAIN EXPRESSION EXTENSION EXTERNAL ' +
  'EXTRACT FALSE FAMILY FETCH FILTER FINALIZE FIRST FOLLOWING FOR FORCE FOREIGN FORMAT FORWARD FREEZE FROM FULL FUNCTION FUNCTIONS ' +
  'GENERATED GLOBAL GRANT GRANTED GROUP GROUPING GROUPS HANDLER HAVING HEADER HOLD HOUR IDENTITY IF ILIKE IMMEDIATE IMMUTABLE IMPLICIT ' +
  'IMPORT IN INCLUDE INCLUDING INCREMENT INDEX INDEXES INHERIT INHERITS INITIALLY INLINE INNER INOUT INPUT INSENSITIVE INSERT INSTEAD ' +
  'INTERSECT INTERVAL INTO INVOKER IS ISNULL ISOLATION JOIN JSON KEY KEYS LABEL LANGUAGE LARGE LAST LATERAL LEADING LEAKPROOF LEFT ' +
  'LEVEL LIKE LIMIT LISTEN LOAD LOCAL LOCALTIME LOCALTIMESTAMP LOCATION LOCK LOCKED LOGGED MAPPING MATCH MATCHED MATERIALIZED MAXVALUE ' +
  'MERGE METHOD MINUTE MINVALUE MODE MONTH MOVE NAME NAMES NATURAL NEW NEXT NFC NO NONE NORMALIZE NOT NOTHING NOTIFY NOTNULL ' +
  'NOWAIT NULL NULLS OBJECT OF OFF OFFSET OIDS OLD ON ONLY OPERATOR OPTION OPTIONS OR ORDER ORDINALITY OTHERS OUT OUTER OVER ' +
  'OVERLAPS OVERRIDING OWNED OWNER PARALLEL PARAMETER PARSER PARTIAL PARTITION PASSING PASSWORD PLACING PLANS POLICY PRECEDING ' +
  'PREPARE PREPARED PRESERVE PRIMARY PRIOR PRIVILEGES PROCEDURAL PROCEDURE PROCEDURES PROGRAM PUBLICATION QUOTE RANGE READ REASSIGN ' +
  'RECURSIVE REF REFERENCES REFERENCING REFRESH REINDEX RELATIVE RELEASE RENAME REPEATABLE REPLACE REPLICA RESET RESTART RESTRICT ' +
  'RETURN RETURNING RETURNS REVOKE RIGHT ROLE ROLLBACK ROLLUP ROUTINE ROUTINES ROW ROWS RULE SAVEPOINT SCHEMA SCHEMAS SCROLL SEARCH ' +
  'SECOND SECURITY SELECT SEQUENCE SEQUENCES SERIALIZABLE SERVER SESSION SESSION_USER SET SETS SHARE SHOW SIMILAR SIMPLE SKIP ' +
  'SNAPSHOT SOME SQL STABLE STANDALONE START STATEMENT STATISTICS STDIN STDOUT STORAGE STORED STRICT STRIP SUBSCRIPTION SUPPORT ' +
  'SYMMETRIC SYSID SYSTEM SYSTEM_USER TABLE TABLES TABLESAMPLE TABLESPACE TEMP TEMPLATE TEMPORARY TEXT THEN TIES TO TRAILING ' +
  'TRANSACTION TRANSFORM TREAT TRIGGER TRUE TRUNCATE TRUSTED TYPE TYPES UESCAPE UNBOUNDED UNCOMMITTED UNENCRYPTED UNION UNIQUE ' +
  'UNKNOWN UNLISTEN UNLOGGED UNTIL UPDATE USER USING VACUUM VALID VALIDATE VALIDATOR VALUE VALUES VARIADIC VERBOSE VERSION VIEW ' +
  'VIEWS VOLATILE WHEN WHERE WHITESPACE WINDOW WITH WITHIN WITHOUT WORK WRAPPER WRITE XML YEAR YES ZONE BUFFERS COSTS TIMING ' +
  'SUMMARY WAL SETTINGS MEMORY SERIALIZE NOTICE EXCEPTION RAISE PERFORM LOOP WHILE EXIT ELSIF FOREACH GET DIAGNOSTICS FOUND'
).split(/\s+/);

export const PG_TYPES = (
  'BIGINT BIGSERIAL BIT BOOL BOOLEAN BOX BYTEA CHAR CHARACTER CIDR CIRCLE DATE DECIMAL DOUBLE FLOAT FLOAT4 FLOAT8 INET INT INT2 ' +
  'INT4 INT8 INTEGER JSONB LINE LSEG MACADDR MACADDR8 MONEY NUMERIC PATH POINT POLYGON PRECISION REAL REGCLASS REGTYPE REGPROC ' +
  'SERIAL SERIAL2 SERIAL4 SERIAL8 SMALLINT SMALLSERIAL TIME TIMESTAMP TIMESTAMPTZ TIMETZ TSQUERY TSVECTOR UUID VARBIT VARCHAR ' +
  'VARYING XID OID RECORD VOID INT4RANGE INT8RANGE NUMRANGE TSRANGE TSTZRANGE DATERANGE CITEXT HSTORE'
).split(/\s+/);

const PG_OPERATOR_WORDS = ['AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'SIMILAR'];

monaco.languages.register({ id: PG_LANG, aliases: ['PostgreSQL', 'SQL'], extensions: ['.sql', '.pgsql'] });

monaco.languages.setLanguageConfiguration(PG_LANG, {
  comments: { lineComment: '--', blockComment: ['/*', '*/'] },
  brackets: [['(', ')'], ['[', ']'], ['{', '}']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
  ],
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  indentationRules: {
    increaseIndentPattern: /^\s*(BEGIN|LOOP|IF\b.*\bTHEN|CASE|DECLARE)\b.*$|\($/i,
    decreaseIndentPattern: /^\s*(END\b|\)).*$/i,
  },
});

monaco.languages.setMonarchTokensProvider(PG_LANG, {
  defaultToken: '',
  tokenPostfix: '.sql',
  ignoreCase: true,
  keywords: PG_KEYWORDS,
  types: PG_TYPES,
  operatorWords: PG_OPERATOR_WORDS,
  brackets: [
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],
  tokenizer: {
    root: [
      { include: '@whitespace' },
      { include: '@comments' },
      [/\$\d+/, 'variable'],
      // dollar-quote delimiters; bodies (DO blocks, functions) are highlighted as SQL code
      [/\$[A-Za-z_]\w*\$|\$\$/, 'string.dollar'],
      [/[eE]'/, { token: 'string', next: '@estring' }],
      [/'/, { token: 'string', next: '@string' }],
      [/"/, { token: 'identifier.quote', next: '@qident' }],
      [/::\s*[A-Za-z_][\w.]*/, 'type'],
      [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
      [/\d+([eE][-+]?\d+)?/, 'number'],
      [/[;,.]/, 'delimiter'],
      [/[()[\]]/, '@brackets'],
      [/:[A-Za-z_]\w*/, 'variable'],
      [
        /[A-Za-z_][\w$]*(?=\s*\()/,
        { cases: { '@keywords': 'keyword', '@types': 'type', '@default': 'predefined' } },
      ],
      [
        /[A-Za-z_][\w$]*/,
        { cases: { '@operatorWords': 'keyword', '@keywords': 'keyword', '@types': 'type', '@default': 'identifier' } },
      ],
      [/[<>=!%&+\-*/|~^#@?]+/, 'operator'],
    ],
    whitespace: [[/\s+/, 'white']],
    comments: [
      [/--.*$/, 'comment'],
      [/\/\*/, { token: 'comment.quote', next: '@comment' }],
    ],
    comment: [
      [/[^*/]+/, 'comment'],
      [/\/\*/, { token: 'comment.quote', next: '@push' }],
      [/\*\//, { token: 'comment.quote', next: '@pop' }],
      [/[*/]/, 'comment'],
    ],
    string: [
      [/[^']+/, 'string'],
      [/''/, 'string'],
      [/'/, { token: 'string', next: '@pop' }],
    ],
    estring: [
      [/[^'\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/''/, 'string'],
      [/'/, { token: 'string', next: '@pop' }],
    ],
    qident: [
      [/[^"]+/, 'identifier'],
      [/""/, 'identifier'],
      [/"/, { token: 'identifier.quote', next: '@pop' }],
    ],
  },
} as monaco.languages.IMonarchLanguage);

monaco.editor.defineTheme('tuplor-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c4b5fd', fontStyle: 'bold' },
    { token: 'string', foreground: '86efac' },
    { token: 'string.dollar', foreground: '4ade80' },
    { token: 'string.escape', foreground: 'fde68a' },
    { token: 'number', foreground: 'fdba74' },
    { token: 'comment', foreground: '6f6f7b', fontStyle: 'italic' },
    { token: 'operator', foreground: 'a3a3ae' },
    { token: 'predefined', foreground: '7dd3fc' },
    { token: 'type', foreground: 'f9a8d4' },
    { token: 'variable', foreground: 'fbbf24' },
    { token: 'identifier', foreground: 'e8e8ec' },
    { token: 'identifier.quote', foreground: 'e8e8ec' },
    { token: 'delimiter', foreground: 'a3a3ae' },
  ],
  colors: {
    'editor.background': '#121316',
    'editor.foreground': '#e8e8ec',
    'editor.lineHighlightBackground': '#1a1b20',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#4a4b55',
    'editorLineNumber.activeForeground': '#a3a3ae',
    'editor.selectionBackground': '#6b85ff40',
    'editor.inactiveSelectionBackground': '#6b85ff22',
    'editorCursor.foreground': '#8198ff',
    'editorWidget.background': '#202126',
    'editorWidget.border': '#2a2b31',
    'editorHoverWidget.background': '#202126',
    'editorHoverWidget.border': '#3a3b43',
    'editorSuggestWidget.background': '#202126',
    'editorSuggestWidget.border': '#2a2b31',
    'editorSuggestWidget.selectedBackground': '#6b85ff33',
    'editorSuggestWidget.highlightForeground': '#8198ff',
    'editorGutter.background': '#121316',
    'editorError.foreground': '#f87171',
    'editorBracketMatch.background': '#6b85ff26',
    'editorBracketMatch.border': '#6b85ff66',
    'scrollbarSlider.background': '#3a3b4366',
    'scrollbarSlider.hoverBackground': '#3a3b43aa',
  },
});

monaco.editor.defineTheme('tuplor-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
    { token: 'string', foreground: '0a7d32' },
    { token: 'string.dollar', foreground: '15803d' },
    { token: 'string.escape', foreground: 'a16207' },
    { token: 'number', foreground: 'b45309' },
    { token: 'comment', foreground: '8e8e99', fontStyle: 'italic' },
    { token: 'predefined', foreground: '0369a1' },
    { token: 'type', foreground: 'be185d' },
    { token: 'variable', foreground: 'b45309' },
    { token: 'operator', foreground: '5b5b66' },
    { token: 'identifier', foreground: '18181b' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#18181b',
    'editor.lineHighlightBackground': '#f7f7f8',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#c4c4cc',
    'editorLineNumber.activeForeground': '#5b5b66',
    'editor.selectionBackground': '#4f6ef733',
    'editorSuggestWidget.selectedBackground': '#4f6ef722',
    'editorSuggestWidget.highlightForeground': '#4f6ef7',
    'editorError.foreground': '#dc2626',
  },
});

loader.config({ monaco });

export const monacoTheme = (t: 'dark' | 'light') => (t === 'dark' ? 'tuplor-dark' : 'tuplor-light');
export { monaco };
