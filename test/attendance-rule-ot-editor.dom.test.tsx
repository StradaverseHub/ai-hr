/**
 * 7c834696 contested — the Overtime band editor, RENDERED.
 *
 * The three things the reporter raised are all UI facts that a source scan can only approximate and a 200
 * from the page cannot see at all:
 *
 *   1. Rounding offers THREE directions (No rounding / Round down / Round up), where it used to offer
 *      Yes and No and the direction — always down — lived out of sight in one line of the engine.
 *   2. Round To is a typed minutes box, not the fixed 15 / 30 / 60 list, and it refuses 0.
 *   3. A new band arrives with an EMPTY rate instead of a pre-filled 1.5, and the flat cell is labelled so
 *      the number reads as the band's multiplier rather than as a decision the system made.
 *
 * What makes rendering worth it rather than another source assertion is the LAST hop: `otRows` is a hidden
 * JSON field, and what the server ultimately stores is whatever string that field holds after the operator
 * has clicked around. Those assertions read the real posted value, not the code that computes it.
 *
 * The final block renders the island once per SHIPPING catalogue. A missing key on this screen returns 200
 * and renders a broken control, so "all six catalogues actually carry the labels this island needs" is
 * pinned here rather than assumed from i18n-check, which answers only "does the key exist somewhere".
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AttendanceRuleOtEditor, type OtEditorLabels, type OtEditorRow } from '../components/attendance-rule-ot-editor';
import enMessages from '../messages/en.json';
import msMessages from '../messages/ms.json';
import zhMessages from '../messages/zh.json';
import taMessages from '../messages/ta.json';
import thMessages from '../messages/th.json';
import viMessages from '../messages/vi.json';

/**
 * The SAME mapping app/admin/attendance-policy/rules/rule-form.tsx makes from the catalogue to the island's
 * props. Duplicated on purpose and kept honest by test/attendance-rule-early-ot-untick.test.ts, which
 * asserts the form still reads exactly these keys — so a key renamed in one place fails in the other.
 */
const labelsFrom = (cat: Record<string, string>): OtEditorLabels => ({
  sectionTitle: cat.otSectionTitle,
  addRow: cat.otAddRow,
  colFrom: cat.otColFrom,
  colTo: cat.otColTo,
  colPattern: cat.otColPattern,
  colRate: cat.otColRate,
  colRounding: cat.otColRounding,
  colRoundTo: cat.otColRoundTo,
  colRemove: cat.otColRemove,
  patternFlat: cat.otPatternFlat,
  patternVariable: cat.otPatternVariable,
  roundingNone: cat.roundingModeNone,
  roundingDown: cat.roundingModeDown,
  roundingUp: cat.roundingModeUp,
  roundToHint: cat.otRoundToHint,
  rateFlatSuffix: cat.otRateFlatSuffix,
  rateUnset: cat.otRateUnset,
  hour: cat.unitHour,
  min: cat.unitMin,
  applyEarlyOtLabel: cat.applyEarlyOtLabel,
  applyEarlyOtHint: cat.applyEarlyOtHint,
  emptyHint: cat.otEmptyHint,
  colPhRate: cat.otColPhRate,
  phRateNone: cat.otPhRateNone,
  ladderGapWarning: cat.otLadderGapWarning,
  ladderOpenEndedWarning: cat.otLadderOpenEndedWarning,
});

const catalogues = {
  en: enMessages,
  ms: msMessages,
  zh: zhMessages,
  ta: taMessages,
  th: thMessages,
  vi: viMessages,
} as Record<string, { admin: { attendanceRule: Record<string, string> } }>;

const EN = labelsFrom(catalogues.en.admin.attendanceRule);

/** One saved band, exactly as rule-form.tsx maps a stored row: 0–59 minutes, flat 1.5, no rounding. */
const savedRow = (over: Partial<OtEditorRow> = {}): OtEditorRow => ({
  fromH: 0,
  fromM: 0,
  toH: 0,
  toM: 59,
  ratePattern: 'flat',
  rate: '1.5',
  phRate: '',
  roundingMode: 'none',
  roundToMinutes: null,
  ...over,
});

/** The hidden field the server action parses — the only thing about this island that reaches the database. */
const postedRows = (container: HTMLElement) =>
  JSON.parse((container.querySelector('input[name="otRows"]') as HTMLInputElement).value);

const renderEditor = (rows: OtEditorRow[], labels: OtEditorLabels = EN) =>
  render(<AttendanceRuleOtEditor initialRows={rows} initialApplyEarlyOt={false} labels={labels} />);

describe('7c834696: the rounding control offers a direction', () => {
  it('renders three options — none, down, up — and no Yes/No', async () => {
    renderEditor([savedRow()]);
    const select = screen.getByLabelText(EN.colRounding) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['none', 'down', 'up']);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      EN.roundingNone,
      EN.roundingDown,
      EN.roundingUp,
    ]);
  });

  it('choosing Round up posts roundingMode "up" and turns the Round To box on', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor([savedRow()]);

    // Before: no rounding, and the box is disabled and empty rather than showing a step nobody chose.
    const roundTo = screen.getByLabelText(EN.colRoundTo) as HTMLInputElement;
    expect(roundTo).toBeDisabled();
    expect(roundTo.value).toBe('');
    expect(postedRows(container)[0]).toMatchObject({ roundingMode: 'none', roundToMinutes: null });

    await user.selectOptions(screen.getByLabelText(EN.colRounding), 'up');
    expect(screen.getByLabelText(EN.colRoundTo)).toBeEnabled();
    expect(postedRows(container)[0]).toMatchObject({ roundingMode: 'up', roundToMinutes: 15 });

    // And back to none: the step is dropped with the mode, so a leftover value cannot keep rounding.
    await user.selectOptions(screen.getByLabelText(EN.colRounding), 'none');
    expect(postedRows(container)[0]).toMatchObject({ roundingMode: 'none', roundToMinutes: null });
  });

  it('a saved band that rounds down reopens saying so', () => {
    const { container } = renderEditor([savedRow({ roundingMode: 'down', roundToMinutes: 60 })]);
    expect((screen.getByLabelText(EN.colRounding) as HTMLSelectElement).value).toBe('down');
    expect((screen.getByLabelText(EN.colRoundTo) as HTMLInputElement).value).toBe('60');
    expect(postedRows(container)[0]).toMatchObject({ roundingMode: 'down', roundToMinutes: 60 });
  });
});

describe('7c834696: Round To is a typed minutes box', () => {
  it('is a number input with a minimum of 1, not a select of 15 / 30 / 60', async () => {
    renderEditor([savedRow({ roundingMode: 'down', roundToMinutes: 60 })]);
    const roundTo = screen.getByLabelText(EN.colRoundTo);
    expect(roundTo.tagName).toBe('INPUT');
    expect(roundTo).toHaveAttribute('type', 'number');
    expect(roundTo).toHaveAttribute('min', '1');
    expect(roundTo).toBeRequired();
  });

  it('accepts a 10-minute step, which the old fixed list could not express at all', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor([savedRow({ roundingMode: 'down', roundToMinutes: 60 })]);
    const roundTo = screen.getByLabelText(EN.colRoundTo);
    await user.clear(roundTo);
    await user.type(roundTo, '10');
    expect(postedRows(container)[0]).toMatchObject({ roundingMode: 'down', roundToMinutes: 10 });
  });
});

describe('7c834696: a new band no longer pre-fills 1.5', () => {
  it('+ Add Row produces a band whose rate is EMPTY and whose posted rate is null, not 0', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor([savedRow()]);
    await user.click(screen.getByRole('button', { name: EN.addRow }));

    const rateBoxes = screen.getAllByLabelText(EN.colRate) as HTMLInputElement[];
    expect(rateBoxes).toHaveLength(2);
    expect(rateBoxes[1].value).toBe('');
    expect(rateBoxes[1]).toBeRequired();

    const posted = postedRows(container);
    expect(posted[0].rate).toBe(1.5); // the saved band is untouched
    // null, NOT 0 — 0 is a real setting ("record the hours but do not pay them"), so the server has to be
    // able to tell "nobody typed anything" from "somebody chose zero", and it refuses the first.
    expect(posted[1].rate).toBeNull();
    // The new band starts one minute after the previous one ends, so the ladder stays saveable.
    expect(posted[1].fromMinutes).toBe(60);
  });

  it('labels the flat rate as a multiplier rather than leaving a bare number', () => {
    renderEditor([savedRow()]);
    expect(screen.getByText(EN.rateFlatSuffix)).toBeInTheDocument();
  });

  it('an empty VARIABLE rate shows "not set" and does not silently select 0×', async () => {
    // Number('') is 0, so without the guard in rateValue an unfilled band would display — and then save —
    // as 0×, which means "record the hours but pay nothing". This is the case that guard exists for.
    const user = userEvent.setup();
    const { container } = renderEditor([savedRow({ rate: '', ratePattern: 'flat' })]);
    await user.selectOptions(screen.getByLabelText(EN.colPattern), 'variable');
    const rate = screen.getByLabelText(EN.colRate) as HTMLSelectElement;
    expect(rate.value).toBe('');
    expect(within(rate).getByRole('option', { name: EN.rateUnset })).toBeInTheDocument();
    expect(postedRows(container)[0].rate).toBeNull();
  });
});

describe('7c834696: every shipping catalogue carries the labels this island needs', () => {
  for (const loc of Object.keys(catalogues)) {
    it(`${loc} renders the three rounding directions with no undefined label`, () => {
      const labels = labelsFrom(catalogues[loc].admin.attendanceRule);
      // A missing key would arrive here as `undefined` and render as an empty control — a 200 with a broken
      // screen, which is the exact failure mode this block exists to catch.
      for (const [k, v] of Object.entries(labels)) {
        expect(typeof v, `${loc}: label ${k} is missing from the catalogue`).toBe('string');
        expect(v.length, `${loc}: label ${k} is empty`).toBeGreaterThan(0);
      }
      renderEditor([savedRow()], labels);
      const select = screen.getByLabelText(labels.colRounding) as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual([
        labels.roundingNone,
        labels.roundingDown,
        labels.roundingUp,
      ]);
    });
  }
});
