/**
 * Pack registry scaffolding (ADR-0080 D8) — the country registry fronts the general registry and
 * behaviour is unchanged: packFor('MY') resolves the MY pack, unknown/absent countries resolve
 * undefined, and the registry enumerates both registered packs: country-my (rung 1) and the
 * attendance module pack (rung 2 — the first module retrofit; its own surface is covered in
 * test/attendance-pack.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { countryPacks, packFor, requirePackFor } from '../localization/registry';
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
      // Rung 5a — the D6 vocabulary surface the kernel now consumes through the registry.
      'states',
      'payComponents',
      'eaFields',
    ] as const) {
      expect(pack[key], `CountryPack.${key} missing`).toBeDefined();
    }
    expect(pack.payroll.pcbExemptionTables.pcb).toBeDefined();
    expect(pack.payroll.pcbExemptionTables.lp).toBeDefined();
    expect(pack.payroll.pcbRemunerationTypes.length).toBeGreaterThan(0);
    expect(pack.payroll.taxReliefCategoryCaps).toBeDefined();
    expect(pack.statutory.normalizeIC('900101-01-9999')).toBe('900101019999');
    expect(pack.statutory.dobFromIC('900101019999')).toBe('1990-01-01');
  });

  // Rung 5a (ADR-0080 D3 at the seam): where the kernel previously had a hard localization/my import
  // (implicitly always-MY), a missing pack must FAIL LOUDLY — never silently default to a jurisdiction.
  // With company.country defaulting 'MY' and MY the only pack, this path is unreachable today.
  it('requirePackFor resolves MY and FAILS LOUDLY for an unknown/absent country', () => {
    expect(requirePackFor('MY')).toBe(myPack);
    expect(() => requirePackFor('SG')).toThrowError(/No country pack registered for country 'SG'/);
    expect(() => requirePackFor(null)).toThrowError(/No country pack registered/);
    expect(() => requirePackFor(undefined)).toThrowError(/No country pack registered/);
  });

  // Rung 5a — tenant-level vocabulary call sites (state catalogs, pay-component seed, PCB
  // classification) take the union across countryPacks(); with MY the only pack that union IS the MY
  // vocabulary, byte-identical to the old direct imports.
  it('countryPacks() enumerates exactly the registered country packs, in registration order', () => {
    expect(countryPacks()).toEqual([myPack]);
  });
});
