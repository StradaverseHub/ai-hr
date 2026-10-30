/**
 * This phone's display preferences: appearance (automatic / light / dark) and language (automatic, or one of the web's
 * six). They belong to the PHONE, not to an account: no personal data, kept across sign-out and company changes, and
 * never sent anywhere except as the Accept-Language every read already carries. Stored in the device keychain store
 * (expo-secure-store) because that is the app's only persistent store; read synchronously at launch so the first
 * screen already has the right language and colours.
 *
 * "Automatic" appearance follows the company's published design (which itself may follow the phone); Light or Dark is
 * the person's own choice and wins, as an accessibility preference should.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

export const APP_LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
export type AppLocaleCode = (typeof APP_LOCALES)[number];
export type AppearancePref = 'auto' | 'light' | 'dark';
export type LanguagePref = 'auto' | AppLocaleCode;
type Prefs = { appearance: AppearancePref; language: LanguagePref };

const KEY = 'aihr.display-preferences.v1';
const DEFAULTS: Prefs = { appearance: 'auto', language: 'auto' };

export function parsePrefs(raw: string | null): Prefs {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return {
      appearance: v.appearance === 'light' || v.appearance === 'dark' ? v.appearance : 'auto',
      language: typeof v.language === 'string' && (APP_LOCALES as readonly string[]).includes(v.language) ? v.language as AppLocaleCode : 'auto',
    };
  } catch { return DEFAULTS; }
}

let current: Prefs | null = null;
const listeners = new Set<() => void>();
function read(): Prefs {
  if (!current) {
    try { current = parsePrefs(SecureStore.getItem(KEY)); } catch { current = DEFAULTS; }
  }
  return current;
}

export function displayPrefs(): Prefs { return read(); }
export function setDisplayPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  current = { ...read(), [key]: value };
  try { SecureStore.setItem(KEY, JSON.stringify(current)); } catch { /* the choice still applies for this run */ }
  listeners.forEach((l) => l());
}
export function subscribeDisplayPrefs(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useDisplayPrefs(): Prefs { return useSyncExternalStore(subscribeDisplayPrefs, read, read); }

/** A screen to reopen after the app re-renders in another language (Settings asks for itself). Read once. */
let reopen: '/settings' | null = null;
export function reopenAfterLanguageChange(path: '/settings') { reopen = path; }
export function takeReopenAfterLanguage(): '/settings' | null { const p = reopen; reopen = null; return p; }
