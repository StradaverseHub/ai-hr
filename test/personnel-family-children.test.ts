/**
 * Item 5988053a / 33a5ce41 → ea36b7fa — Family tab drift guards, re-pinned for the CONSOLIDATED design:
 * the three per-relationship sections (Spouse / Children / Other Dependants) are merged into ONE
 * "Family & Dependents Information" card — a single table of every family member plus a single
 * Add Family Member dialog where the Relationship is selected FIRST and the form adapts to it
 * (components/family-relationship-fields.tsx swapping the server-rendered field panels).
 *
 * Source-static guard (precedent: test/personnel-bank-statutory-tab.test.ts, test/identity-tax-controls.test.ts)
 * over the employee-detail page + the two dialog islands. The dialog forms post the SAME field names
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
const REL_FIELDS = fs.readFileSync(
  path.resolve(__dirname, '../components/family-relationship-fields.tsx'),
  'utf8',
);
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Personnel — consolidated Family & Dependents Information (ea36b7fa)', () => {
  it('mounts every named dependent input the server actions read', () => {
    // Literal name="..." inputs/selects/textareas across the dependent form panels (add + edit share
    // dependentFields, so each appears exactly once in page source). The `relationship` select moved into
    // the FamilyRelationshipFields island — checked separately below.
    const named = [
      'fullName',
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
    // The ONE relationship select lives in the island (rendered FIRST, above the panels).
    expect(REL_FIELDS.includes('name="relationship"')).toBe(true);
    expect(REL_FIELDS.includes('required')).toBe(true);
    // The page no longer mounts its own relationship control (no hidden per-section input either).
    expect(PAGE.includes('<select name="relationship"')).toBe(false);
    expect(PAGE.includes('<input type="hidden" name="relationship"')).toBe(false);
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

  it('renders ONE consolidated family table — the per-relationship sections are gone', () => {
    // The old three-section machinery no longer exists...
    expect(PAGE.includes('familySpouseSection')).toBe(false);
    expect(PAGE.includes('familyChildrenSection')).toBe(false);
    expect(PAGE.includes('familyOtherSection')).toBe(false);
    expect(PAGE.includes('spouseDeps')).toBe(false);
    expect(PAGE.includes('childDeps')).toBe(false);
    expect(PAGE.includes('otherDeps')).toBe(false);
    // ...replaced by the single table over the spouse-first sorted list, inside the SAME card anchor
    // (id="section-family" is load-bearing for links/tests).
    expect(PAGE.includes('{familyMembersSection}')).toBe(true);
    expect(PAGE.includes('id="section-family"')).toBe(true);
    expect(PAGE.includes('const relationshipRank')).toBe(true);
    expect(PAGE.includes('{familyMembers.map((d) => (')).toBe(true);
    // Consolidated columns: name / relationship / DOB / age / contact / tax-relief flag / actions.
    for (const col of ['name', 'relationship', 'dateOfBirth', 'childAge', 'contactNumber', 'countsTowardRelief', 'actions']) {
      expect(PAGE.includes(`t('family.${col}')`), `missing column header family.${col}`).toBe(true);
    }
    // The tax-relief column reflects the number actually reaching payroll: the SAME per-row predicate
    // eligibleChildReliefCount counts (core/dependents.ts isChildReliefEligible).
    expect(PAGE.includes('isChildReliefEligible(d)')).toBe(true);
    // Age is SERVER-derived via the ONE shared rule (no client Date.now() derivation for the table).
    expect(PAGE.includes('childAgeYears(d.dateOfBirth)')).toBe(true);
    expect(PAGE.includes('const dobAgeYears')).toBe(false);
    // Wide table scrolls inside its own container; empty state reuses the shared key.
    expect(PAGE.includes('overflow-x-auto')).toBe(true);
    expect(PAGE.includes("t('family.none')")).toBe(true);
  });

  it('offers ONE Add Family Member flow and per-row View / Edit / Delete', () => {
    // Single Add dialog (the separate Add spouse / Add child / Add dependant flows are gone).
    expect(PAGE.includes("triggerLabel={t('family.add')} title={t('family.addFamilyTitle')}")).toBe(true);
    expect(PAGE.includes('{dialogForm(null)}')).toBe(true);
    expect(PAGE.includes("t('family.addSpouse')")).toBe(false);
    expect(PAGE.includes("t('family.addChild')")).toBe(false);
    expect(PAGE.includes("t('family.addDependant')")).toBe(false);
    // Per-row Edit dialog (same adaptive form) and read-only View dialog.
    expect(PAGE.includes('{dialogForm(d)}')).toBe(true);
    expect(PAGE.includes('{viewDialogBody(d)}')).toBe(true);
    expect(PAGE.includes("title={t('family.editFamilyTitle')}")).toBe(true);
    expect(PAGE.includes("title={t('family.viewFamilyTitle')}")).toBe(true);
    // Delete via ConfirmSubmit around the untouched archive action, with the unified copy.
    expect(PAGE.includes('<form action={archiveDependentAction}>')).toBe(true);
    expect(PAGE.includes("title={t('family.deleteFamilyConfirmTitle')}")).toBe(true);
    expect(PAGE.includes("description={t('family.deleteFamilyConfirmBody')}")).toBe(true);
  });

  it('adapts the dialog form to the selected relationship via the island (relationship FIRST)', () => {
    // The unified form hands the three server-rendered panels to the client island; the island holds ONLY
    // the selected relationship and swaps panels — spouse fields for spouse, child + tax relief for child,
    // the standard panel for everything else (incl. custom catalog types).
    expect(PAGE.includes('<FamilyRelationshipFields')).toBe(true);
    expect(PAGE.includes("spousePanel={<div className=\"grid grid-cols-1 items-end gap-3 sm:grid-cols-2\">{dependentFields('spouse', d)}</div>}")).toBe(true);
    expect(PAGE.includes("childPanel={<div className=\"space-y-4\">{dependentFields('child', d)}</div>}")).toBe(true);
    expect(PAGE.includes("otherPanel={<div className=\"grid grid-cols-1 items-end gap-3 sm:grid-cols-2\">{dependentFields('other', d)}</div>}")).toBe(true);
    expect(PAGE.includes("initialValue={d?.relationship ?? ''}")).toBe(true);
    // Inactive panels are disabled AND hidden — disabled controls never submit, so the duplicate field
    // names / __present markers across panels cannot corrupt the post.
    expect(REL_FIELDS.includes("disabled={panel !== 'spouse'} hidden={panel !== 'spouse'}")).toBe(true);
    expect(REL_FIELDS.includes("disabled={panel !== 'child'} hidden={panel !== 'child'}")).toBe(true);
    expect(REL_FIELDS.includes("disabled={panel !== 'other'} hidden={panel !== 'other'}")).toBe(true);
  });

  it('backs the Relationship dropdown with the dependentRelationship catalog (built-in fallback)', () => {
    // Catalog-driven options with built-in i18n labels for the five core values; an unseeded catalog falls
    // back to DEPENDENT_RELATIONSHIPS so the dropdown never goes blank; an edited row whose stored value is
    // deactivated / custom is merged back in so Edit never loses it.
    expect(PAGE.includes('profileOptions.dependentRelationship')).toBe(true);
    expect(PAGE.includes('const activeRelationshipOptions')).toBe(true);
    expect(PAGE.includes('const relationshipOptionsFor')).toBe(true);
    expect(PAGE.includes('options={relationshipOptionsFor(d)}')).toBe(true);
    expect(PAGE.includes('DEPENDENT_RELATIONSHIPS.map((r) => ({ value: r, label: relationshipLabel(r) }))')).toBe(true);
  });

  it('keeps the read-only View dialog a disabled fieldset, never a form', () => {
    // View renders EXACTLY the matching Edit panel inside <fieldset disabled> — no <form>, no submit
    // button — so it can never drift from the form and can never post.
    expect(PAGE.includes('<fieldset disabled>')).toBe(true);
    const viewBody = PAGE.slice(PAGE.indexOf('const viewDialogBody'), PAGE.indexOf('const familyMembersSection'));
    expect(viewBody.length).toBeGreaterThan(0);
    expect(viewBody.includes('<form')).toBe(false);
    expect(viewBody.includes('action=')).toBe(false);
  });

  it('groups the child dialog panel into the three labelled fieldsets', () => {
    for (const legend of ['sectionPersonal', 'sectionEducation', 'sectionTaxRelief']) {
      expect(PAGE.includes(`t('family.${legend}')`), `missing fieldset legend family.${legend}`).toBe(true);
    }
  });

  it('dialog islands stay pure shells: no core import, no optimistic close', () => {
    // core/dependents.ts imports db/client (pg driver) — a value import here would break the client bundle.
    expect(DIALOG.includes("from '@/core/")).toBe(false);
    expect(DIALOG.includes("'use client'")).toBe(true);
    expect(REL_FIELDS.includes("from '@/core/")).toBe(false);
    expect(REL_FIELDS.includes("'use client'")).toBe(true);
    // The redirect dismisses the dialog; an eager close would mask the ?error= redirect (plan 5e).
    expect(DIALOG.includes('onSubmit={() => setOpen(false)}')).toBe(false);
  });

  it('has every consolidated-design family key in all six locales — and the retired ones are gone', () => {
    const keys = [
      'title',
      'add',
      'edit',
      'view',
      'none',
      'relationshipPlaceholder',
      'addFamilyTitle',
      'editFamilyTitle',
      'viewFamilyTitle',
      'deleteFamilyConfirmTitle',
      'deleteFamilyConfirmBody',
      // Retained field/section keys the panels still render.
      'sectionPersonal',
      'sectionEducation',
      'sectionTaxRelief',
      'studyLevel',
      'studyCountry',
      'countsTowardRelief',
      'ageHint',
    ];
    // The per-section keys retired by the consolidation must be OUT of en.json, so a stale t() call would
    // fail i18n coverage instead of silently rendering a raw key.
    const retired = [
      'spouseSection',
      'childrenSection',
      'otherSection',
      'addSpouse',
      'addChild',
      'addDependant',
      'viewSpouseTitle',
      'viewChildTitle',
      'viewOtherTitle',
      'editSpouseTitle',
      'editOtherTitle',
      'deleteSpouseConfirmTitle',
      'deleteOtherConfirmTitle',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const fam = msg?.people?.detail?.family ?? {};
      for (const k of keys) {
        expect(typeof fam[k], `messages/${loc}.json missing people.detail.family.${k}`).toBe('string');
        expect((fam[k] as string).length, `messages/${loc}.json family.${k} is empty`).toBeGreaterThan(0);
      }
      for (const k of retired) {
        expect(fam[k], `messages/${loc}.json still carries retired key people.detail.family.${k}`).toBeUndefined();
      }
      // The System Labels grid needs the new catalog category's display name in every locale.
      const cat = msg?.admin?.profileOptions?.category ?? {};
      expect(typeof cat.dependentRelationship, `messages/${loc}.json missing admin.profileOptions.category.dependentRelationship`).toBe('string');
    }
  });
});
