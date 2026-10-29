/** The app's shared date/time words (mobile/lib/attendance-format.ts), as Inbox and the attendance notes print them. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

function format(locale: 'en' | 'ms') {
  const module = { exports: {} as Record<string, (...a: string[]) => string> };
  runInNewContext(transpileModule(readFileSync('mobile/lib/attendance-format.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: (id: string) => { if (id === './i18n') return { appLocale: () => locale, t: (k: string) => k }; throw new Error('Unexpected ' + id); } });
  return module.exports;
}

describe('readable business time zone', () => {
  it('names the zone as people say it, in the app language, instead of the IANA id', () => {
    expect(format('en').fmtZoneName('Asia/Kuala_Lumpur')).toBe('Malaysia Time');
    expect(format('ms').fmtZoneName('Asia/Kuala_Lumpur')).toBe('Waktu Malaysia');
  });
  it('falls back to the id for a zone the runtime cannot name or does not know', () => {
    expect(format('en').fmtZoneName('Not/AZone')).toBe('Not/AZone');
    expect(format('en').fmtZoneName('Etc/GMT-3')).toBe('Etc/GMT-3');
  });
  it('prints an instant in the named zone in the app style', () => {
    expect(format('en').fmtInstant('2026-10-29T03:01:18Z', 'Asia/Kuala_Lumpur')).toBe('29 Oct 2026, 11:01');
  });
});
