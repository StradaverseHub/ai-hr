/**
 * Pack registry scaffolding (ADR-0080 D8, rung 1) — the country registry fronts the general
 * registry and behaviour is unchanged: packFor('MY') resolves the MY pack, unknown/absent
 * countries resolve undefined, and the registry enumerates the one registered pack (country-my).
 * No module pack is registered in rung 1 (the Attendance rung is the first).
 */
import { describe, expect, it } from 'vitest';
import { packFor } from '../localization/registry';
import { myPack } from '../localization/my';
import { listPacks, packById } from '../packs/registry';

describe('ADR-0080 D8: pack registry rung-1 wiring', () => {
  it('packFor resolves MY (case-insensitively) and refuses unknowns', () => {
    expect(packFor('MY')).toBe(myPack);
    expect(packFor('my')).toBe(myPack);
    expect(packFor('SG')).toBeUndefined();
    expect(packFor(null)).toBeUndefined();
    expect(packFor(undefined)).toBeUndefined();
    expect(packFor('')).toBeUndefined();
  });

  it('the general registry carries country-my and zero module packs', () => {
    const entry = packById('country-my');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('country');
    expect(listPacks('country').map((p) => p.id)).toEqual(['country-my']);
    expect(listPacks('module')).toEqual([]);
    expect(listPacks()).toHaveLength(1);
  });

  it('the resolved pack exposes the CountryPack surface', () => {
    const pack = packFor('MY')!;
    expect(pack.country).toBe('MY');
    for (const key of [
      'statutory',
      'companyStatutory',
      'leave',
      'holidays',
      'payroll',
      'statutoryConfig',
      'reports',
      'eaStatement',
    ] as const) {
      expect(pack[key], `CountryPack.${key} missing`).toBeDefined();
    }
  });
});
