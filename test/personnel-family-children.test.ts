/**
 * Item 5988053a — Family tab: child records as a table + Add/Edit dialog + delete confirmation.
 *
 * Source-static guard (precedent: test/personnel-bank-statutory-tab.test.ts, test/identity-tax-controls.test.ts,
 * test/statutory-my-layout.test.ts) over the employee-detail page. The dialog forms post the SAME field names
 * dependent-actions.ts reads (including the `__present` tri-state markers editBool depends on), and the dialog
 * form is PORTALLED OUT of the PersonnelTabs shell, so the shell's capture-phase submit listener never injects
 * the hidden `tab` field — the page must carry a STATIC hidden tab input instead (feedback bd2f0bb2). This test
 * is the only automated protection against a silent field-drops-on-save or tab-retention regression.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const DIALOG = fs.readFileSync(path.resolve(__dirname, '../components/family-form-dialog.tsx'), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Personnel — Family children table + dialog (5988053a)', () => {
  it('mounts every named dependent input the server actions read', () => {
    // Literal name="..." inputs/selects/textareas across the dependent forms (add + edit share
    // dependentFields, so each appears exactly once in source).
    const named = [
      'fullName',
      'relationship',
      'gender',
      'dateOfBirth',
      'phone',
      'icOrPassport',
      'passportNumber',
      'residentialAddress',
      'marriageDate',
      'marriageStatus',
      'occupation',
      'companyName',
      'employerAddress',
      'schoolName',
      'studyLevel',
      'childReliefCategory',
      'childReliefPercentage',
      'remarks',
    ];
    for (const field of named) {
      expect(PAGE.includes(`name="${field}"`), `missing dependent input name="${field}"`).toBe(true);
    }
    // studyCountry renders through the catalog-backed ProfileOptionSelect (legacy-value tolerant), fed by
    // the already-loaded profile_option country catalog — not a hand-rolled select.
    expect(PAGE.includes('name="studyCountry"')).toBe(true);
    expect(/<ProfileOptionSelect\s+name="studyCountry"/.test(PAGE.replace(/\s+/g, ' '))).toBe(true);
    expect(PAGE.includes('options={profileOptions.country}')).toBe(true);
  });

  it('keeps every tri-state checkbox (and its __present marker mechanism) mounted', () => {
    // familyCheckbox emits BOTH the checkbox and its hidden `${name}__present` marker —
    // dependent-actions.ts editBool depends on the marker to distinguish unticked from absent.
    expect(PAGE.includes('name={`${name}__present`}')).toBe(true);
    for (const box of ['isBeneficiary', 'spouseWorking', 'isStudent', 'isDeceased', 'childTaxRelief']) {
      expect(PAGE.includes(`familyCheckbox('${box}'`), `missing familyCheckbox('${box}')`).toBe(true);
    }
  });

  it('carries the static hidden tab field inside the portalled dialog forms (bd2f0bb2 retention)', () => {
    // Dialog.Portal reparents the form OUT of the tab shell, so the shell's capture submit listener never
    // sees it (components/personnel-tabs.tsx guards with shell.contains(form)). The static input — with the
    // data-tab-tracker attribute the listener looks for — is the mechanism that keeps a dialog save on the
    // Family tab.
    expect(PAGE.includes('<input type="hidden" name="tab" value="family" data-tab-tracker="" />')).toBe(true);
  });

  it('renders the children section as a table + dialogs, not the old details cards', () => {
    // The child call of familySection is gone (spouse/other keep theirs)...
    expect(PAGE.includes("familySection('family.childrenSection'")).toBe(false);
    expect(PAGE.includes("familySection('family.spouseSection'")).toBe(true);
    expect(PAGE.includes("familySection('family.otherSection'")).toBe(true);
    // ...replaced by the server-JSX table inside the dialog island, with the payroll-facing column driven
    // by the SAME shared predicate the head count uses.
    expect(PAGE.includes('{familyChildrenSection}')).toBe(true);
    expect(PAGE.includes('<FamilyFormDialog')).toBe(true);
    expect(PAGE.includes("t('family.countsTowardRelief')")).toBe(true);
    expect(PAGE.includes('isChildReliefEligible(d)')).toBe(true);
    // Age is server-derived via the ONE shared rule (no client Date.now() derivation for the table).
    expect(PAGE.includes('childAgeYears(d.dateOfBirth)')).toBe(true);
    expect(PAGE.includes('const dobAgeYears')).toBe(false);
    // Wide table scrolls inside its own container.
    expect(PAGE.includes('overflow-x-auto')).toBe(true);
    // Delete goes through the confirmation wrapper around the untouched archive action.
    expect(PAGE.includes('<form action={archiveDependentAction}>')).toBe(true);
    expect(PAGE.includes("title={t('family.deleteConfirmTitle')}")).toBe(true);
  });

  it('groups the child dialog form into the three labelled fieldsets', () => {
    for (const legend of ['sectionPersonal', 'sectionEducation', 'sectionTaxRelief']) {
      expect(PAGE.includes(`t('family.${legend}')`), `missing fieldset legend family.${legend}`).toBe(true);
    }
  });

  it('dialog island stays a pure shell: no core import, no optimistic close', () => {
    // core/dependents.ts imports db/client (pg driver) — a value import here would break the client bundle.
    expect(DIALOG.includes("from '@/core/")).toBe(false);
    expect(DIALOG.includes("'use client'")).toBe(true);
    // The redirect dismisses the dialog; an eager close would mask the ?error= redirect (plan 5e).
    expect(DIALOG.includes('onSubmit={() => setOpen(false)}')).toBe(false);
  });

  it('has all 13 new family keys in all six locales (no raw key at runtime)', () => {
    const keys = [
      'addTitle',
      'editTitle',
      'sectionPersonal',
      'sectionEducation',
      'sectionTaxRelief',
      'studyLevel',
      'studyCountry',
      'statusInactive',
      'countsTowardRelief',
      'deleteConfirmTitle',
      'deleteConfirmBody',
      'emptyTable',
      'ageHint',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const fam = msg?.people?.detail?.family ?? {};
      for (const k of keys) {
        expect(typeof fam[k], `messages/${loc}.json missing people.detail.family.${k}`).toBe('string');
        expect((fam[k] as string).length, `messages/${loc}.json family.${k} is empty`).toBeGreaterThan(0);
      }
    }
  });
});
