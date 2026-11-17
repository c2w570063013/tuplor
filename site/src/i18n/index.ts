import { SITE, type Lang } from '../config';
import en, { type Dict } from './en';
import zhTW from './zh-TW';

export const LANGS: Lang[] = ['en', 'zh-TW'];
export const HTML_LANG: Record<Lang, string> = { en: 'en', 'zh-TW': 'zh-Hant-TW' };
export const OG_LOCALE: Record<Lang, string> = { en: 'en_US', 'zh-TW': 'zh_TW' };

const VARS: Record<string, string> = {
  name: SITE.name,
  license: SITE.license,
  version: SITE.version,
  owner: SITE.owner,
  repo: SITE.repo,
};

/** Replace {name}, {license}, {version}, {owner}, {repo} in every string of a dictionary. */
function fill<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/\{(\w+)\}/g, (m, k) => VARS[k] ?? m) as T;
  if (Array.isArray(v)) return v.map(fill) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) as T;
  return v;
}

const DICTS: Record<Lang, Dict> = { en: fill(en), 'zh-TW': fill(zhTW) };
export const t = (lang: Lang): Dict => DICTS[lang];

/** Path of the home page in a given language, respecting the configured base path. */
export function homePath(lang: Lang): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return lang === 'en' ? base : `${base}zh-TW/`;
}

/** Absolute URL for a file in /public, respecting the base path. */
export function asset(path: string): string {
  return import.meta.env.BASE_URL.replace(/\/?$/, '/') + path.replace(/^\//, '');
}
