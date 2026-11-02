import en from './remembered-mfa-copy/en.json';
import ms from './remembered-mfa-copy/ms.json';
import zh from './remembered-mfa-copy/zh.json';
import ta from './remembered-mfa-copy/ta.json';
import th from './remembered-mfa-copy/th.json';
import vi from './remembered-mfa-copy/vi.json';
const copy = { en, ms, zh, ta, th, vi };
export function rememberedMfaCopy(locale: string) { return copy[locale as keyof typeof copy] ?? en; }
