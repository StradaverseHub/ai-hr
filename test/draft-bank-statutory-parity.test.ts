/**
 * Board 2c1b2fba (approved plan item 8) — ONE Bank & Statutory form, not two.
 *
 * The reporter asked that any new field, statutory setting or bank configuration added to the Active Employee's
 * Bank & Statutory tab also appear on the Draft Employee page. This check makes that a rule: every Bank & Statutory
 * descriptor in lib/personnel-field-registry.ts must be carried by a draft (`scope: 'both'`), or sit on the explicit
 * AFTER-ACTIVATION allowlist below — facts that can only exist once there is an employee. The allowlist may only
 * SHRINK: a new record-only field fails here until it is added to the draft (and to `completeEmployeeDraft`) or is
 * argued onto this list in review.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import {
  DRAFT_CHILD_RELIEF_CATEGORIES,
  draftChildReliefKey,
  draftChildReliefTable,
  missingByTab,
} from '../lib/employee-draft-schema';

/** Repeated PCB child-relief rows: one per qualifying child, derived from the Family register after activation. */
const AFTER_ACTIVATION = [
  'bank_statutory.income_tax_pcb.category',
  'bank_statutory.income_tax_pcb.item',
  'bank_statutory.income_tax_pcb.qualifyingunits',
  'bank_statutory.income_tax_pcb.reliefamount',
  'bank_statutory.income_tax_pcb.share',
] as const;

const bankStatutory = PERSONNEL_FIELDS.filter((f) => f.id.startsWith('bank_statutory.'));

describe('Bank & Statutory: the draft carries every field the record has, or the field is after-activation only', () => {
  it('reads a non-empty slice of the registry', () => {
    expect(bankStatutory.length).toBeGreaterThan(40);
  });

  it('every record-only (scope employment) descriptor is on the after-activation allowlist', () => {
    const recordOnly = bankStatutory.filter((f) => f.scope === 'employment').map((f) => f.id).sort();
    expect(recordOnly).toEqual([...AFTER_ACTIVATION].sort());
  });

  it('the allowlist names live descriptors only (it may only shrink)', () => {
    for (const id of AFTER_ACTIVATION) expect(bankStatutory.some((f) => f.id === id), id).toBe(true);
  });

  it('bank payee residency and the declared child-relief grid are now draft fields', () => {
    const ids = new Set(bankStatutory.filter((f) => f.scope === 'both').map((f) => f.id));
    expect(ids.has('bank_statutory.bank_information.bankpayeeresidency')).toBe(true);
    for (const cat of ['under_18', 'study_preu', 'study_tertiary', 'disabled', 'disabled_study'])
      for (const share of ['full', 'half']) expect(ids.has(`bank_statutory.income_tax_pcb.childrelieftable_${cat}_${share}`), `${cat} ${share}`).toBe(true);
  });

  it('the draft screen renders both new controls and Activate writes both through their owners', () => {
    const wizard = readFileSync('app/admin/personnel/new/wizard.tsx', 'utf8');
    expect(wizard).toContain('bank_statutory.bank_information.bankpayeeresidency');
    expect(wizard).toContain('draftChildReliefKey');
    const activation = readFileSync('core/employee-draft.ts', 'utf8');
    expect(activation).toContain('bankPayeeResidency: payeeResidency');
    expect(activation).toContain('childReliefTable: childReliefGrid');
  });
});

describe('the declared child-relief grid on a draft', () => {
  it('reads blank boxes as 0 and refuses a box that is not a whole number of zero or more', () => {
    const grid = draftChildReliefTable({ [draftChildReliefKey('under_18', 'full')]: '2', [draftChildReliefKey('disabled', 'half')]: '1' });
    expect(grid).toEqual({
      under_18: { full: 2, half: 0 },
      study_preu: { full: 0, half: 0 },
      study_tertiary: { full: 0, half: 0 },
      disabled: { full: 0, half: 1 },
      disabled_study: { full: 0, half: 0 },
    });
    expect(Object.keys(grid!)).toEqual([...DRAFT_CHILD_RELIEF_CATEGORIES]);
    expect(draftChildReliefTable({ [draftChildReliefKey('study_preu', 'full')]: '1.5' })).toBeNull();
    expect(draftChildReliefTable({ [draftChildReliefKey('study_preu', 'full')]: '-1' })).toBeNull();
  });

  it('is judged only under "Auto (from table)", and a bad payee residency is named', () => {
    const bad = { [draftChildReliefKey('under_18', 'full')]: 'x' };
    expect(missingByTab({ statutory: { childReliefMode: 'auto_table', ...bad } }).bankStatutory).toContain('childReliefTable');
    expect(missingByTab({ statutory: { childReliefMode: 'manual', ...bad } }).bankStatutory).not.toContain('childReliefTable');
    expect(missingByTab({ statutory: { bankPayeeResidency: 'maybe' } }).bankStatutory).toContain('bankPayeeResidency');
    expect(missingByTab({ statutory: { bankPayeeResidency: 'non_resident' } }).bankStatutory).not.toContain('bankPayeeResidency');
  });
});
