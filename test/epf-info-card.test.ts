/**
 * Feedback 127dffba — EPF Contribution Information Card redesign (Personnel · Bank & Statutory tab).
 *
 * Presentation-only change: label rename (EPF Mode → EPF Category), a grey placeholder on the EPF
 * Number field, removal of the disabled `manual_fixed` dropdown option, and the EPF fieldset presented
 * as a visually-distinct card. The persisted epf_mode enum (auto | voluntary_excess | exempt) and the
 * UI→enum mapping MUST stay unchanged — these tests pin that invariant alongside the surface changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapEpfUiMode } from '../lib/epf-mode-map';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('EPF Info Card (127dffba)', () => {
  /**
   * ══ ITEM 70b14723 — WHAT THIS TEST USED TO CLAIM, AND WHICH HALF IS NOW FALSE ══
   *
   * Quoted so the reversal is auditable rather than invisible in a diff. The name was:
   *
   *     it('mapEpfUiMode still yields only the three lawful enum values (mapping unchanged)', …)
   *         const lawful = new Set(['auto', 'voluntary_excess', 'exempt']);
   *         // Deferred fixed-amount coerces defensively to auto.
   *         expect(mapEpfUiMode('manual_fixed', 500, 500).epfMode).toBe('auto');
   *
   * THERE ARE FOUR LAWFUL VALUES NOW, not three: migration 0491 added `manual_amount` and ADR-0087 reverses
   * the deferral ADR-0035 §4 and ADR-0046 made. 127dffba's OWN invariant — that the mapper can never produce
   * a value the enum cannot store — is what this test was really for, and it is unchanged and still pinned;
   * it is the LIST that moved. The `manual_fixed` coercion stays asserted, for the reason 127dffba wrote it:
   * that literal was the disabled "coming soon" option, names no side and carries no figure.
   */
  it('mapEpfUiMode still yields only LAWFUL enum values (four of them since 0491)', () => {
    const lawful = new Set(['auto', 'voluntary_excess', 'exempt', 'manual_amount']);
    for (const ui of [
      'auto',
      'manual_percentage',
      'semi_auto',
      'manual_fixed',
      'manual_employee_amount',
      'manual_employer_amount',
      'manual_both_amount',
      'none',
      'garbage',
      null,
      undefined,
    ]) {
      const { epfMode } = mapEpfUiMode(ui, null, null);
      expect(lawful.has(epfMode), `${String(ui)} -> ${epfMode}`).toBe(true);
    }
    // …and the list is the DB enum's own, read from the schema, so the two cannot drift apart.
    const schemaSrc = read('db/schema.ts');
    const decl = schemaSrc.slice(schemaSrc.indexOf("pgEnum('epf_mode'"));
    for (const v of lawful) expect(decl.slice(0, 200), `${v} is a stored epf_mode label`).toContain(`'${v}'`);
    // Spot-check the canonical shapes are preserved.
    expect(mapEpfUiMode('auto', null, null).epfMode).toBe('auto');
    expect(mapEpfUiMode('manual_percentage', 11, 13)).toMatchObject({ epfMode: 'voluntary_excess', epfEmployeeRate: 0.11, epfEmployerRate: 0.13 });
    expect(mapEpfUiMode('semi_auto', 11, null)).toMatchObject({ epfMode: 'voluntary_excess', epfEmployeeRate: 0.11, epfEmployerRate: null });
    expect(mapEpfUiMode('none', null, null).epfMode).toBe('exempt');
    // The RETIRED literal still coerces defensively to auto — see the block above.
    expect(mapEpfUiMode('manual_fixed', 500, 500).epfMode).toBe('auto');
  });

  it('EPF Category dropdown no longer offers the manual_fixed option, and does offer the three named ones', () => {
    const src = read('components/epf-election.tsx');
    expect(src).not.toMatch(/<option[^>]*value="manual_fixed"/);
    // The other four categories remain, plus 70b14723's three.
    for (const v of [
      'auto',
      'manual_percentage',
      'semi_auto',
      'none',
      'manual_employee_amount',
      'manual_employer_amount',
      'manual_both_amount',
    ]) {
      expect(src, v).toMatch(new RegExp(`<option value="${v}"`));
    }
  });

  it('EPF Number input carries the grey placeholder 123456789 and no hardcoded default', () => {
    // Item 35b7af0a group 4 moved this input into the shared EPF field group so the Create New Employee
    // wizard renders the identical control. 127dffba's invariant is unchanged and still pinned — it is now
    // expressed across two files, so the assertions follow it rather than being retired:
    //   * the placeholder lives on the input, in the component;
    //   * "no hardcoded default" is now `props.epfNumber ?? ''` in the component (blank when unset, never a
    //     baked-in sample) bound to `defaultValue` in form mode;
    //   * the page still supplies the STORED value, which is the half a component-only check would miss.
    const src = read('components/epf-registration-fields.tsx');
    const at = src.indexOf("t('epfNumber')");
    expect(at, 'the EPF Number field is defined in the shared group').toBeGreaterThan(-1);
    const field = src.slice(at, src.indexOf("t('epfCitizenship')", at));
    expect(field).toContain('placeholder="123456789"');
    expect(field).toContain("name: 'epfNumber'");
    expect(field).toContain('defaultValue: epfNumber');
    // Blank when empty, never a baked-in sample.
    expect(src).toContain("const epfNumber = props.epfNumber ?? '';");
    // …and the Personnel screen still feeds it the stored value.
    const page = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(page).toContain('epfNumber={statutory?.epfNumber}');
  });

  it('EPF label reads "EPF Category" (en) and is renamed across all 6 locales', () => {
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      const label = dict?.people?.detail?.epfMode;
      expect(label, `${loc} epfMode present`).toBeTruthy();
      // The old English wording must be gone from every locale.
      expect(String(label).toLowerCase(), `${loc} not "EPF mode"`).not.toBe('epf mode');
    }
    const en = JSON.parse(read('messages/en.json'));
    expect(en.people.detail.epfMode).toBe('EPF Category');
  });
});
