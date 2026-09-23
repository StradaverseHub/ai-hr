/**
 * 2a1a6f42 (r331) — THE EA'S PREVIEW BUTTON, RENDERED, IN ALL SIX LANGUAGES.
 *
 * ⚠️ WHY THIS FILE EXISTS AND A SOURCE SCAN WOULD NOT DO (CLAUDE.md §8: "a key is not a screen"). The EA
 * screen's picker is only rendered when the year has a paid population, and `db/seed.ts` plants NO payroll
 * at all — test/72b100cd-pcb2ii-preview.test.ts pins that. So the dev-server render check of
 * `/payroll/statutory-forms/ea` can only ever exercise the EMPTY branch, and the branch that carries the
 * new button is unreachable from seeded data. This renders it directly instead, with the strings the
 * screen resolves, out of the SHIPPING catalogues.
 *
 * FOUR THINGS ONLY A RENDER CAN SAY:
 *   1. The button EXISTS and carries the word, in each of the six locales — a `t('eaPreview')` that
 *      resolved to nothing would leave a nameless control, which no grep of the page source would catch.
 *   2. It retargets THIS form at the preview route (`formaction`) and opens a new tab (`formtarget`), so
 *      the preview is generated from the identical selection, company, year and language the download uses
 *      and the picker is not emptied behind it.
 *   3. It is refused with nothing ticked, exactly as the download beside it is — a preview that was
 *      pressable when the download was not would be the lighter control by one click.
 *   4. THE PROPS ARE STILL OPTIONAL. r328 built the preview as two optional props and left the EA passing
 *      neither; r331 switched the EA on. Omitting them must still render NO button, or "optional" is a
 *      claim about a file rather than about the control.
 *
 * Scope note: jsdom applies no CSS, so nothing here says anything about where the button sits.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EaEmployeePicker, type EaPickerRow, type EaPickerStrings } from '../app/payroll/statutory-forms/ea/employee-picker';
import { MAX_EA_SELECTION } from '../app/payroll/statutory-forms/ea/limits';
// The SHIPPING catalogues, not fixtures — a missing or blank `eaPreview` would be missing from these six
// files, and that is the whole point of the locale block below. (jsdom gives import.meta.url an http URL,
// so readFileSync off it is not available here; static imports are how the other DOM tests load messages.)
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Loc = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Loc[];

const words = (loc: Loc) => CATALOGUES[loc].payroll.statutoryForms as unknown as Record<string, string>;

/** Exactly what `app/payroll/statutory-forms/ea/page.tsx` hands the picker, resolved for one locale. */
function stringsFor(loc: Loc): EaPickerStrings {
  const w = words(loc);
  return {
    searchName: w.eaSearchName,
    searchNamePlaceholder: w.eaSearchNamePlaceholder,
    searchCode: w.eaSearchCode,
    searchCodePlaceholder: w.eaSearchCodePlaceholder,
    selectAll: w.eaSelectAll,
    clear: w.eaClear,
    selectedTemplate: w.eaSelectedCount,
    generate: w.eaGenerate,
    preview: w.eaPreview,
    colSelect: w.eaColSelect,
    colCode: w.eaColCode,
    colName: w.colEmployee,
    colDepartment: w.eaColDepartment,
    colStatus: w.colStatus,
    noMatch: w.eaNoMatch,
    tooMany: w.eaTooMany.replace('{max}', String(MAX_EA_SELECTION)),
  };
}

const ROWS: EaPickerRow[] = [
  { employmentId: '11111111-1111-4111-8111-111111111111', name: 'Lim Wei Ming', code: 'A0001', department: 'Finance', status: 'active', statusLabel: 'Active' },
  { employmentId: '22222222-2222-4222-8222-222222222222', name: 'Tan Sri Abu', code: 'A0002', department: 'Operations', status: 'resigned', statusLabel: 'Resigned' },
];

/** The EA screen's own call site: its download route, its preview route, its hidden criteria. */
const mount = (opts: { loc?: Loc; withPreview?: boolean } = {}) => {
  const loc = opts.loc ?? 'en';
  const s = stringsFor(loc);
  return render(
    <EaEmployeePicker
      rows={ROWS}
      action="/payroll/statutory-forms/ea/download"
      previewAction={opts.withPreview === false ? undefined : '/payroll/statutory-forms/ea/preview'}
      hidden={[
        { name: 'companyId', value: '33333333-3333-4333-8333-333333333333' },
        { name: 'year', value: '2026' },
        { name: 'lang', value: 'ms' },
      ]}
      strings={opts.withPreview === false ? { ...s, preview: undefined } : s}
    />,
  );
};

const previewButton = (loc: Loc = 'en') => screen.getByRole('button', { name: words(loc).eaPreview });

describe('2a1a6f42 · the C.P.8A (EA) picker now offers a Preview', () => {
  it('renders the button, retargeted at the EA preview route, opening a new tab', async () => {
    mount();
    const btn = previewButton();
    expect(btn.getAttribute('type'), 'it SUBMITS the picker’s own form').toBe('submit');
    // `formAction` retargets THIS submit, so the preview is built from the identical selection, company,
    // year and language the download would use. A separate link would be a second place to build it from.
    expect(btn.getAttribute('formaction')).toBe('/payroll/statutory-forms/ea/preview');
    expect(btn.getAttribute('formtarget'), 'the selection must survive being looked at').toBe('_blank');
    // And the form it retargets is the download's form, carrying the criteria unchanged.
    const form = btn.closest('form')!;
    expect(form.getAttribute('action')).toBe('/payroll/statutory-forms/ea/download');
    expect(form.getAttribute('method')).toBe('get');
  });

  it('is refused with nothing ticked, exactly as the download is, and carries the SAME selection', async () => {
    const user = userEvent.setup();
    mount();
    const btn = previewButton();
    const generate = screen.getByRole('button', { name: words('en').eaGenerate });
    // Nothing ticked is nothing to produce — on BOTH buttons, or the preview is the lighter control.
    expect((btn as HTMLButtonElement).disabled, 'no selection, no preview').toBe(true);
    expect((generate as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: 'Lim Wei Ming' }));
    expect((btn as HTMLButtonElement).disabled, 'one person ticked, preview available').toBe(false);
    expect((generate as HTMLButtonElement).disabled).toBe(false);

    // THE POINT OF RETARGETING ONE FORM RATHER THAN BUILDING A SECOND: what the preview would submit is
    // byte-identical to what the download would, because it is the same form.
    const fd = new FormData(btn.closest('form')!);
    expect(fd.getAll('id')).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(fd.get('companyId')).toBe('33333333-3333-4333-8333-333333333333');
    expect(fd.get('year')).toBe('2026');
    expect(fd.get('lang'), 'the language rides through to the preview, never re-decided').toBe('ms');
  });

  /**
   * ⚠️ THE r328 CLAIM, RENDERED RATHER THAN GREPPED. The preview landed as two OPTIONAL props on this
   * SHARED picker precisely so PCB 2(II) could have one while the EA did not. r331 switched the EA on,
   * and the optionality has to survive it: a screen that supplies neither still gets no button.
   */
  it('renders NO button when a screen supplies neither prop', () => {
    const { container } = mount({ withPreview: false });
    // ⚠️ ASKED STRUCTURALLY, NOT BY NAME. Querying for a button CALLED "Preview" is green either way: a
    // button rendered unconditionally with `strings.preview` undefined has no accessible name, so the
    // name lookup returns null and the case passes while the control is on screen. Verified: relaxing the
    // picker's condition to `true &&` left that lookup null and this case green. Count the submits and
    // look for the retarget instead — both survive a nameless button.
    expect(container.querySelectorAll('button[type="submit"], form button:not([type])').length, 'ONE submit, the download').toBe(1);
    expect(container.querySelector('[formaction]'), 'nothing retargets the form').toBeNull();
    expect(container.querySelector('[formtarget]'), 'and nothing opens a new tab').toBeNull();
    // The rest of the control is untouched — this is not "the picker failed to render".
    expect(screen.getByRole('button', { name: words('en').eaGenerate })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Lim Wei Ming' })).toBeTruthy();
  });

  /**
   * AND THE MIRROR OF IT, so the count above cannot pass because the picker stopped rendering buttons at
   * all: with both props the form carries TWO submits, the preview and the download.
   */
  it('renders exactly TWO submits when a screen supplies both', () => {
    const { container } = mount();
    expect(container.querySelectorAll('button[type="submit"], form button:not([type])').length).toBe(2);
    expect(container.querySelectorAll('[formaction]').length, 'and only the preview retargets').toBe(1);
  });

  it('carries a real word in every locale — a key that resolved to nothing is a nameless control', () => {
    for (const loc of LOCALES) {
      mount({ loc });
      const label = words(loc).eaPreview;
      expect(typeof label, `${loc}: eaPreview`).toBe('string');
      expect(label.trim(), `${loc}: eaPreview must not be blank`).not.toBe('');
      // Found BY that word: if the catalogue were missing the key the button would carry no accessible
      // name and this lookup would throw rather than quietly passing.
      expect(previewButton(loc).getAttribute('formaction')).toBe('/payroll/statutory-forms/ea/preview');
      cleanup();
    }
  });
});
