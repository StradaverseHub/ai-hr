/** The app's shared date/time words (mobile/lib/attendance-format.ts), as Inbox and the attendance notes print them. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

function format(locale: 'en' | 'ms') {
  const module = { exports: {} as Record<string, (...a: string[]) => string> };
  runInNewContext(transpileModule(readFileSync('mobile/lib/attendance-format.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: (id: string) => { if (id === './i18n') return { appLocale: () => locale, intlLocale: () => (locale === 'ms' ? 'ms-MY' : 'en-MY'), t: (k: string) => k }; throw new Error('Unexpected ' + id); } });
  return module.exports;
}

describe('readable business time zone', () => {
  it('names the zone by its place, the same on every runtime and in every app language, instead of the IANA id', () => {
    // Hermes names Asia/Kuala_Lumpur "Malaysia" and Node "Malaysia Time", so a runtime-supplied name read "in Malaysia." on the phone.
    expect(format('en').fmtZoneName('Asia/Kuala_Lumpur')).toBe('Kuala Lumpur');
    expect(format('ms').fmtZoneName('Asia/Kuala_Lumpur')).toBe('Kuala Lumpur');
    expect(format('en').fmtZoneName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });
  it('falls back to the id where it names no place', () => {
    expect(format('en').fmtZoneName('Etc/GMT-3')).toBe('Etc/GMT-3');
    expect(format('en').fmtZoneName('')).toBe('');
  });
  it('prints an instant in the named zone in the app style', () => {
    expect(format('en').fmtInstant('2026-10-29T03:01:18Z', 'Asia/Kuala_Lumpur')).toBe('29 Oct 2026, 11:01');
  });
});
