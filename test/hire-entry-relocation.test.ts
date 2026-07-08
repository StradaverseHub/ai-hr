/**
 * Hire-entry relocation + rename (feedback 5c9b73f2) — static-source guard.
 *
 * The Personnel (Admin) page moved the new-employee creation surface from a collapsed
 * "+ Hire an employee" <details> at the BOTTOM of the page to a prominent top-right
 * "+ Create new employee" primary button (in the PageHeader actions) that toggles the same hire form,
 * now rendered ABOVE the employee listing. Pure UI relocation + rename — the form fields, `hireAction`,
 * validations, permissions, and the org-cascade inline script are unchanged.
 *
 * This DB-free / jsdom-free guard fails loudly if a future edit half-reverts the relocation, drops the
 * cascade ids the org-filter script depends on (feedback c87bc26a), clobbers the filter panel
 * (feedback 3542ed4a), or removes/renames the i18n keys.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('Hire entry: relocated to a prominent top button + renamed', () => {
  const src = read('app/admin/personnel/page.tsx');

  it('drops the old collapsed <details>/<summary> entry point and its label', () => {
    expect(src.includes('<details>')).toBe(false);
    expect(src.includes('<summary')).toBe(false);
    expect(src.includes("t('hireAnEmployee')")).toBe(false);
  });

  it('renders the renamed primary button in the PageHeader actions', () => {
    expect(src).toMatch(/<HireFormButton[^>]*label=\{t\('createNewEmployee'\)\}/);
    // The button carries the onboarding-tour anchor (via the HireFormButton dataTour prop); it appears
    // exactly once on the page now — the old <details> Card no longer holds a people-hire anchor.
    expect((src.match(/dataTour="people-hire"/g) ?? []).length).toBe(1);
    expect(src.includes('data-tour="people-hire"')).toBe(false);
  });

  it('places the hire form panel ABOVE the employee listing', () => {
    const panelAt = src.indexOf('<HireFormPanel>');
    const tableAt = src.indexOf('data-tour="people-table"');
    expect(panelAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(-1);
    expect(panelAt).toBeLessThan(tableAt);
  });

  it('preserves the org-cascade contract (feedback c87bc26a)', () => {
    for (const id of ['hire-company', 'hire-business-unit', 'hire-department', 'hire-position', 'hire-cost-center']) {
      expect(src.includes(`id="${id}"`), id).toBe(true);
    }
    expect(src.includes('HIRE_ORG_FILTER_SCRIPT')).toBe(true);
    expect(src.includes('dangerouslySetInnerHTML')).toBe(true);
  });

  it('preserves the filter panel (feedback 3542ed4a)', () => {
    expect(src.includes('dataTour="people-search"')).toBe(true);
  });

  it('still posts the unchanged hireAction', () => {
    expect(src.includes('action={hireAction}')).toBe(true);
  });
});

describe('Hire entry: client island toggles via hidden, not conditional mount', () => {
  const src = read('components/hire-employee.tsx');

  it('is a client island', () => {
    expect(src.startsWith("'use client'")).toBe(true);
  });

  it('keeps the form mounted and toggles visibility with the hidden attribute', () => {
    expect(src.includes('hidden={!open}')).toBe(true);
    // Must NOT conditionally mount the children (would defer/replay the org-cascade <script>).
    expect(src.includes('{open && children}')).toBe(false);
  });

  it('exports the composition pieces the page wires together', () => {
    for (const name of ['HireFormProvider', 'HireFormButton', 'HireFormPanel', 'HireFormCancelButton']) {
      expect(src.includes(`export function ${name}`), name).toBe(true);
    }
  });
});

describe('Hire entry: i18n + tour metadata', () => {
  it('en.json people.list gains createNewEmployee + emptyNoEmployeesAdmin and drops hireAnEmployee', () => {
    const en = JSON.parse(read('messages/en.json')) as {
      people: { list: Record<string, string> };
    };
    expect(en.people.list.createNewEmployee).toBeTruthy();
    expect(en.people.list.emptyNoEmployeesAdmin).toBeTruthy();
    expect(en.people.list.hireAnEmployee).toBeUndefined();
  });

  it('the onboarding tour anchors the hire step on the button and opens below it', () => {
    const tours = JSON.parse(read('lib/module-tours.json')) as Record<
      string,
      { steps?: { id: string; target: string; placement: string }[] }
    >;
    const hire = tours.people.steps?.find((s) => s.id === 'hire');
    expect(hire?.target).toBe('[data-tour="people-hire"]');
    expect(hire?.placement).toBe('bottom');
  });
});
