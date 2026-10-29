import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import mobile from '../mobile/lib/internal-auth-copy.json';
import en from '../messages/en.json';
function keys(value: Record<string, unknown>, prefix = ''): string[] { return Object.entries(value).flatMap(([key, v]) => v && typeof v === 'object' ? keys(v as Record<string, unknown>, prefix + key + '.') : [prefix + key]).sort(); }
describe('embedded auth language contracts', () => {
  it('provides every login, MFA, invitation, recovery and refusal label in all six web languages', () => {
    for (const locale of ['en','ms','zh','vi','ta','th']) {
      const catalogue = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).internalAuth;
      expect(keys(catalogue)).toEqual(keys(en.internalAuth));
      for (const key of Object.keys(en.internalAuth)) expect(catalogue[key]).toBeTruthy();
    }
  });
  it('the native copy is the same owned authentication vocabulary in all six languages', () => {
    for (const locale of ['en','ms','zh','ta','th','vi'] as const) expect(mobile[locale]).toEqual(JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).internalAuth);
  });
});
