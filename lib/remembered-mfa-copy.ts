import en from '../messages/remembered-mfa/en.json';
import ms from '../messages/remembered-mfa/ms.json';
import zh from '../messages/remembered-mfa/zh.json';
import ta from '../messages/remembered-mfa/ta.json';
import th from '../messages/remembered-mfa/th.json';
import vi from '../messages/remembered-mfa/vi.json';
const copy = { en, ms, zh, ta, th, vi };
export function rememberedMfaCopy(locale: string) { return copy[locale as keyof typeof copy] ?? en; }
