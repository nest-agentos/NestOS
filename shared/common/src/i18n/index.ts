import {createModuleLogger} from '../utils/MemoryLogger';
import {randomUUID} from '../utils/random';
// @file: common/i18n/index.ts
// Lightweight i18n — no runtime dependencies, tree-shakeable.
//
// Usage:
//   import { t, setLocale } from '@nestos/common';
//
//   t('skill.toast.saved')               // '已保存'
//   t('skill.toast.imported', { count: 3 }) // '已导入 3 个 Skill'
//   await setLocale('en');                     // switch to English

import { zhCN } from './zh-CN';
import type { LocaleStrings } from './zh-CN';
export type { LocaleKey, LocaleStrings } from './zh-CN';

import {getLocale,setLocaleCode} from './locale';
export {getLocale} from './locale';
export type {Locale} from './locale';
import type {Locale} from './locale';

const LOCALES:Partial<Record<Locale,LocaleStrings>>={'zh-CN':zhCN};
let changing=0;const log=createModuleLogger('i18n');
/** Switching language loads its catalog first; a newer selection supersedes an older load. */
export async function setLocale(locale:Locale):Promise<void> {
    if(!['zh-CN','en'].includes(locale))throw Object.assign(new Error('LOCALE_UNSUPPORTED'),{code:'LOCALE_UNSUPPORTED'});
    const generation=++changing;
    if(LOCALES[locale]){setLocaleCode(locale);return;}
    const strings=await loadLocale(locale);
    if(generation===changing){LOCALES[locale]=strings;setLocaleCode(locale);}
}
async function loadLocale(locale:Locale):Promise<LocaleStrings> {
    if(LOCALES[locale])return LOCALES[locale]!;
    const started=Date.now(),operationId=randomUUID();
    try {
        const strings=locale==='en'?(await import('./en')).en:zhCN;LOCALES[locale]=strings;
        log.info('locale.load',{operationId,stage:'catalog',result:'success',durationMs:Date.now()-started});return strings;
    }catch{
        log.warn('locale.load',{operationId,stage:'catalog',result:'failure',code:'LOCALE_MODULE_LOAD_FAILED',durationMs:Date.now()-started});
        throw Object.assign(new Error('LOCALE_MODULE_LOAD_FAILED'),{code:'LOCALE_MODULE_LOAD_FAILED'});
    }
}
/** Legacy label inspection is explicit and does not add inactive catalogs to startup. */
export async function translatedValues(key:import('./zh-CN').LocaleKey):Promise<readonly string[]> {
    const catalogs=await Promise.all([loadLocale('zh-CN'),loadLocale('en')]);
    return [...new Set(catalogs.map(strings=>strings[key]))];
}

/**
 * Translate a key to the current locale's string.
 *
 * Fallback chain: current locale → zh-CN → key itself.
 *
 * @param key     A dot-namespaced key, e.g. 'skill.toast.saved'
 * @param params  Optional interpolation map; replaces `{param}` occurrences.
 *
 * @example
 *   t('skill.toast.imported', { count: 3 }) // '已导入 3 个 Skill'
 */
export function t(key: import('./zh-CN').LocaleKey, params?: Record<string, string | number>): string {
    const strings = LOCALES[getLocale()] ?? LOCALES['zh-CN'];
    let str: string = (strings as Record<string, string>)[key]
        ?? (LOCALES['zh-CN'] as Record<string, string>)[key]
        ?? key;

    if (params) {
        for (const [k, v] of Object.entries(params)) {
            str = str.replaceAll(`{${k}}`, String(v));
        }
    }

    return str;
}

// Re-export everything from sub-modules for a single import point
export * from './icons';
export * from './zh-CN';
