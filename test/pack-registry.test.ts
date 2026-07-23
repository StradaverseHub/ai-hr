/**
 * Pack registry scaffolding (ADR-0080 D8) — the country registry fronts the general registry and
 * behaviour is unchanged: packFor('MY') resolves the MY pack, unknown/absent countries resolve
 * undefined, and the registry enumerates both registered packs: country-my (rung 1) and the
 * attendance module pack (rung 2 — the first module retrofit; its own surface is covered in
 * test/attendance-pack.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { packFor } from '../localization/registry';
import { myPack } from '../localization/my';
import '../packs/attendance';
import { listPacks, modulePackById, packById } from '../packs/registry';

describe('ADR-0080 D8: pack registry rung-1 wiring', () => {
  it('packFor resolves MY (case-insensitively) and refuses unknowns', () => {
    expect(packFor('MY')).toBe(myPack);
    expect(packFor('my')).toBe(myPack);
    expect(packFor('SG')).toBeUndefined();
    expect(packFor(null)).toBeUndefined();
    expect(packFor(undefined)).toBeUndefined();
    expect(packFor('')).toBeUndefined();
  });

  it('the general registry carries country-my and the attendance module pack', () => {
    const entry = packById('country-my');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('country');
    expect(listPacks('country').map((p) => p.id)).toEqual(['country-my']);
    expect(listPacks('module').map((p) => p.id)).toEqual(['attendance']);
    expect(listPacks()).toHaveLength(2);
    // Kind-narrowed lookup: module ids resolve, country ids do not cross kinds.
    expect(modulePackById('attendance')?.id).toBe('attendance');
    expect(modulePackById('country-my')).toBeUndefined();
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
