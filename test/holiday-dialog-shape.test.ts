/**
 * def44f29 — Add / Edit holiday is a DIALOG over the list, and National / State is changeable.
 * SOURCE GUARD, in the shape of the 1b87e8a0 guard in test/movement-settings.test.ts.
 *
 * THE COMPLAINT. "Add holiday" was an anchor jump (`href="#add-holiday"`) to a form card BELOW the paged
 * list; every row was an inline edit form attached by `form=`; National / State was read-only text and
 * no form on the screen could set it, so every holiday added there was national and moving one to a
 * state was delete-and-recreate.
 *
 * WHAT THIS GUARD HOLDS, and why each line is here rather than in prose:
 *  1. ONE surface, and it is a MODAL, opened from the list header AND from every row. A second Add/Edit
 *     affordance is how a screen ends up with two ways to do one thing.
 *  2. THE BOTTOM CARD AND THE `form=` ROW FORMS ARE GONE, not hidden. The page renders no holiday form of
 *     its own; only Remove stays a row post, because a row with nothing typed in it has nothing to lose.
 *  3. A REFUSED SAVE KEEPS THE DIALOG OPEN WITH THE TYPING INTACT: the action RETURNS its refusal (a
 *     redirect navigates the route out from under the dialog), the fields are CONTROLLED, and the
 *     post-action form reset is cancelled (React 19 resets the form when the action settles, and a
 *     controlled <select> does not survive that — reproduced on the movement dialog).
 *  4. THE PAGE STAYS A SERVER COMPONENT feeding the island serialisable values only; no t() and no core/
 *     import in the island.
 *  5. THE NATIONAL / STATE CONTRACT crosses three files and is pinned in all three: the island posts
 *     `state` only when the row's scope is not fixed, the action reads the field's PRESENCE, and the
 *     service refuses a state on a business-group / holiday-group row regardless.
 *  6. THE STATE LIST COMES FROM THE PACK (countryPacks()), never a second hand-typed copy.
 *  7. THE SAVE STILL LANDS ON THE ROW'S PAGE (9da61c86): the four filter fields ride inside the dialog
 *     and holidaysPath reads exactly those four.
 *  8. The nine new labels exist, non-empty, in all six locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { holidayStatesByCountry } from '../app/admin/holidays/holiday-state-options';
import { MY_STATES } from '../localization/my/holidays';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments stripped: these files document the very shapes asserted here, so prose could both fail a
 *  negative and satisfy a positive. The `[^:]` guard keeps `https://` intact. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const rawPage = read('app/admin/holidays/page.tsx');
const rawDialog = read('app/admin/holidays/holiday-dialog.tsx');
const page = codeOnly(rawPage);
const dialog = codeOnly(rawDialog);
const helper = codeOnly(read('app/admin/holidays/holiday-state-options.ts'));
const actions = codeOnly(read('app/admin/actions.ts'));
const service = codeOnly(read('core/admin.ts'));

const between = (src: string, from: string, to: string, what: string) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + 1);
  expect(start, `${what}: start marker found`).toBeGreaterThan(-1);
  expect(end, `${what}: end marker found after the start`).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe('def44f29 — Add / Edit holiday is a dialog over the list', () => {
  it('1. one surface, a Radix modal in its own client island, opened from the header and from every row', () => {
    expect(rawDialog).toMatch(/^'use client';/);
    expect(dialog).toContain("from '@radix-ui/react-dialog'");
    expect(dialog).toContain('<Dialog.Content');
    expect(rawPage, 'the page stays a server component').not.toMatch(/^\s*['"]use client['"]\s*;/m);
    expect(page).toContain('<HolidayDialog');
    expect(page, 'the page opens the dialog from the list header AND from every row').toMatch(
      /triggerClassName=\{btnPrimary\}[\s\S]*triggerClassName=\{rowActionCls\}/,
    );
    // Add and Edit are one component with different words: the header opens it with no id, the row with its id.
    expect(page).toMatch(/id=\{null\}/);
    expect(page).toMatch(/id=\{h\.id\}/);
  });

  it('2. the bottom card and the form= row forms are gone; only Remove is still a row post', () => {
    expect(page, 'no anchor jump to a form below the list').not.toContain('#add-holiday');
    expect(page).not.toContain('id="add-holiday"');
    expect(page, 'no detached edit forms attached by form=').not.toMatch(/\bform=\{/);
    expect(page, 'no add/edit form of its own').not.toContain('name="holidayDate"');
    expect(page).not.toContain('name="holidayType"');
    expect(page).not.toContain('name="state"');
    expect(page).not.toContain('name="name"');
    expect(page).not.toContain('createHolidayAction');
    expect(page).not.toContain('updateHolidayAction');
    expect(actions, 'the redirecting create/update actions are retired, not kept alongside').not.toContain(
      'export async function createHolidayAction',
    );
    expect(actions).not.toContain('export async function updateHolidayAction');
    // Remove: a plain row post, still through the redirecting helper.
    expect(page).toContain('action={deleteHolidayAction}');
    const del = between(actions, 'export async function deleteHolidayAction', '\n}', 'deleteHolidayAction');
    expect(del).toContain('ok(path)');
    // The rows are text now — the National / State cell derives from h.state (the 3e831868 pin, kept).
    expect(page).toMatch(/h\.state \? h\.state : t\('national'\)/);
  });

  it('3. a refused save RETURNS; the fields are controlled; the post-action reset is cancelled', () => {
    const save = between(
      actions,
      'export async function saveHolidayAction',
      'export async function deleteHolidayAction',
      'saveHolidayAction',
    );
    expect(save, 'a redirect would close the dialog and lose the typing').not.toContain('redirect(');
    expect(save).not.toMatch(/\bfail\(/);
    expect(save).not.toMatch(/\bok\(/);
    expect(save).toContain('return { ok: false, error:');
    expect(save).toContain('return { ok: true, path:');
    // One action, insert or update by the presence of an id — the dialog's hidden field.
    expect(save).toContain('await updateHoliday(s, { id,');
    expect(save).toContain('await createHoliday(s, { country,');
    expect(dialog).toMatch(/\{id && <input type="hidden" name="id" value=\{id\} \/>\}/);

    expect(dialog).toContain('useActionState');
    expect(dialog).toContain('saveHolidayAction');
    for (const [value, setter] of [
      ['name', 'setName'],
      ['holidayDate', 'setHolidayDate'],
      ['holidayState', 'setHolidayState'],
      ['holidayType', 'setHolidayType'],
      ['country', 'setCountry'],
    ] as const) {
      expect(dialog, `${value} is a controlled field`).toMatch(
        new RegExp(`value=\\{${value}\\}[\\s\\S]*?onChange=\\{\\(e\\) => \\{?\\s*(?:const next = e\\.target\\.value;\\s*)?${setter}\\(`),
      );
    }
    expect(dialog).toMatch(/checked=\{active\}[\s\S]*?onChange=\{\(e\) => setActive\(e\.target\.checked\)\}/);
    expect(dialog).toMatch(/checked=\{tentative\}[\s\S]*?onChange=\{\(e\) => setTentative\(e\.target\.checked\)\}/);
    expect(dialog, 'an uncontrolled field is reset by React when the action settles').not.toContain('defaultValue');
    expect(dialog).not.toContain('defaultChecked');
    // The post-action reset is never REQUESTED: the form has no `action` prop and dispatches the
    // useActionState action itself from onSubmit inside startTransition. Cancelling the reset with
    // onReset (the movement dialog's defence) cannot work — react-dom 19.2 disables its own event
    // listener for the commit phase in which it calls form.reset() — proved in holiday-dialog.dom.test.tsx.
    expect(dialog, 'a form action would make React reset the form when it settles').not.toContain('action={formAction}');
    expect(dialog).toMatch(/onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*const formData = new FormData\(e\.currentTarget\);\s*startTransition\(\(\) => formAction\(formData\)\);/);
    expect(dialog).toMatch(/onReset=\{\(e\) => e\.preventDefault\(\)\}/);
    // The error paints IN the dialog rather than as a page-level banner behind it.
    expect(dialog).toContain('<ErrorBanner message={state.error} />');
    // Success: the island navigates to the path the action answered with, then closes.
    expect(dialog).toMatch(/if \(state\?\.ok\) \{[\s\S]*?router\.push\(state\.path\)/);
  });

  it('4. server page, serialisable props only: no t() and no core/ import in the island', () => {
    expect(dialog, 'labels arrive pre-translated from the server page').not.toMatch(/useTranslations|getTranslations/);
    expect(dialog).not.toMatch(/\bt\(/);
    expect(dialog, 'the island reads no domain module').not.toContain("from '@/core/");
    expect(dialog).not.toContain("from '@/db/");
    expect(dialog).not.toContain("from '@/localization/");
    // Every label the island shows is a key the page resolves — pinned by name so a missing one is a
    // test failure here, not MISSING_MESSAGE on the screen.
    for (const key of [
      'addTitle',
      'addHint',
      'editTitle',
      'editHint',
      'nationalStateLabel',
      'nationalStateHint',
      'national',
      'scopeFixedHint',
      'edit',
      'cancel',
      'saving',
      'close',
      'save',
      'remove',
      'inactiveBadge',
      'tentativeBadge',
    ]) {
      expect(page, `page resolves t('${key}')`).toContain(`t('${key}')`);
    }
    // No dynamic scope keys (test/i18n-coverage.test.ts cannot see them).
    expect(page).not.toMatch(/t\(`scope\./);
  });

  it('5. the National / State contract holds across island, action and service', () => {
    // The island: exactly one state picker, rendered only when the row's scope is not fixed.
    expect(dialog.match(/name="state"/g) ?? [], 'exactly one state picker').toHaveLength(1);
    expect(dialog).toMatch(/fixedScope \? \([\s\S]*?readOnly disabled[\s\S]*?\) : \([\s\S]*?name="state"/);
    expect(dialog).toContain('<option value="">{labels.national}</option>');
    // The action: presence decides. Absent = leave alone; '' = national; a label = that state.
    expect(actions).toContain("formData.has('state')");
    expect(actions).toMatch(/state: state \?\? null/);
    // The service: state is a tri-state update input, refused on a scoped row, validated against the pack.
    const update = between(service, 'export async function updateHoliday(', 'export async function deleteHoliday(', 'updateHoliday');
    expect(update).toMatch(/state\?: string \| null;/);
    expect(update).toContain('if (before.companyId || before.holidayGroupId)');
    expect(update).toContain('business group or holiday group');
    expect(update).toContain('statesForCountries([before.country])');
    // …and create validates against the same vocabulary, so no path writes a state the pack lacks.
    const create = between(service, 'export async function createHoliday(', 'export async function updateHoliday(', 'createHoliday');
    expect(create).toContain('statesForCountries([country])');
    // …and the audit payload carries the NEW state (it used to copy before.state on both sides).
    expect(update).toMatch(/after = \{[\s\S]*?state: nextState !== undefined \? nextState : before\.state,/);
    expect(update).not.toMatch(/after: \{[\s\S]*?state: before\.state/);
    // The page passes a fixed label, and no picker, for a business-group / holiday-group row.
    expect(page).toContain('fixedScope={fixedScopeOf(h)}');
  });

  it('6. the state list comes from the country pack, never a hand-typed copy — and it is the WHOLE list', () => {
    // The page reads the list through its own helper module (a page file may export nothing extra), and
    // the helper reads the registry.
    expect(page).toContain("from './holiday-state-options'");
    expect(page).toMatch(/const statesByCountry = holidayStatesByCountry\(\)/);
    expect(page).toMatch(/statesByCountry=\{statesByCountry\}/);
    expect(helper).toContain("from '@/localization/registry'");
    expect(helper).toContain('countryPacks()');
    for (const src of [page, dialog, helper]) {
      expect(src).not.toMatch(/'Sabah'|'Sarawak'|'Selangor'|'Kuala Lumpur'/);
      expect(src).not.toContain('MY_STATES');
    }
    // BEHAVIOURAL, not a source pin: what the page actually hands the dialog for MY is the pack's list,
    // entry for entry and in the pack's order. A slice, a filter or a stale copy fails here — the
    // verifier showed that slicing the list to three states passed every source guard.
    const offered = holidayStatesByCountry();
    expect(offered.MY).toEqual([...MY_STATES]);
    expect(offered.MY).toHaveLength(16);
  });

  it('7. the filter rides inside the dialog and holidaysPath reads exactly those fields', () => {
    for (const name of ['filterCountry', 'filterYear', 'filterPage']) {
      expect(dialog, `the dialog posts ${name}`).toContain(`name="${name}"`);
      expect(actions, `the action reads ${name}`).toContain(`formData.get('${name}')`);
    }
    // Size only when the reader chose one — the same rule the page's own hidden fields follow.
    expect(dialog).toMatch(/\{filter\.size && <input type="hidden" name="filterSize"/);
    expect(actions).toContain("formData.get('filterSize')");
    expect(page).toMatch(/size: sp\.size \? String\(pq\.size\) : ''/);
    // The success path is the follow path (land on the row's page), not the posted-from path.
    expect(actions).toMatch(/return \{ ok: true, path: await holidayFollowPath\(/);
  });

  it('8. the dialog labels exist, non-empty, in all six locales', () => {
    for (const loc of LOCALES) {
      const h = JSON.parse(read(`messages/${loc}.json`)).admin.holidays;
      for (const k of ['editTitle', 'editHint', 'nationalStateLabel', 'nationalStateHint', 'scopeFixedHint', 'edit', 'cancel', 'saving', 'close']) {
        expect(typeof h[k], `${loc}: admin.holidays.${k}`).toBe('string');
        expect(h[k].length, `${loc}: admin.holidays.${k} is non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
