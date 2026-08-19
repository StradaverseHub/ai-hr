/**
 * 65e2d5de — "Payroll Process: improve the Reset / Reprocess workflow".
 *
 * THREE OF THE SIX ASKS WERE ALREADY BUILT when this item was planned, and that is recorded here rather
 * than re-implemented: Remove Employee Payroll is its own screen with a search, a required reason and an
 * audit record (9066bd6c); Back exists on every screen below Payroll Process and returns the list with the
 * operator's filters intact (9066bd6c + lib/return-to.ts); the Pay Period wizard is already `pageWideCls`.
 * A fourth — Recalculation History no longer on the run screen — was done by e440991b.
 *
 * WHAT THIS FILE GUARDS is the remainder, and every case is a SOURCE-SHAPE assertion for the same reason
 * the sibling payroll guards are: a width, a menu placement and a cookie polarity are all strings, and
 * tsc, the suite and `next build` are indifferent to every one of them.
 *
 *   A. The Actions column. The four processed-row controls that were pushing the grid sideways are now
 *      View + a ⋯ menu — and each action keeps its OWN unchanged visibility condition on the server page.
 *   B. The menu island decides placement and nothing else, and never renders a menu of one.
 *   C. Recalculation History folds, CLOSED by default, and the just-submitted job's result panel does not.
 *   D. The reprocess search carries its ticked-but-hidden ids, pinned at the source as well as by
 *      FormData in test/payroll-reprocess-form.dom.test.tsx (rule 17: the defect lives in the contract
 *      BETWEEN the review block and the form, so both halves are asserted).
 *   E. Every message key this round mints resolves in all six catalogues and takes no ICU argument.
 *
 * The reset DESTINATION — the item's first ask, and a reversal of 7076f8af — is guarded where that
 * decision already lived: test/payroll-reset-flow-7076f8af.test.ts case 1 and test/payroll-draft-resume
 * case a3, both updated rather than duplicated here. The widths are in test/payroll-screens-layout.test.ts
 * for the same reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment DESCRIBING a control must never satisfy a guard for it. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LIST = code('app/payroll/page.tsx');
const ISLAND = code('app/payroll/row-actions.tsx');
const REPROCESS_PAGE = code('app/payroll/[batchId]/reprocess/page.tsx');
const REPROCESS_FORM = code('app/payroll/[batchId]/reprocess/reprocess-form.tsx');

/** The body of the row-action island's JSX on the list page — what the ⋯ menu is actually holding. */
const menuSlot = (() => {
  const open = LIST.indexOf('<PayrollRowActions');
  const close = LIST.indexOf('</PayrollRowActions>');
  expect(open, 'the list no longer renders the row-action island').toBeGreaterThan(-1);
  expect(close, 'the island is self-closing — it has no actions in it').toBeGreaterThan(open);
  return LIST.slice(open, close);
})();

describe('65e2d5de · A — the Actions column is View plus a menu, and the gates are untouched', () => {
  it('the three heavy actions moved INSIDE the menu, each keeping its own condition verbatim', () => {
    // WHICH ACTION IS OFFERED FOR WHICH STATUS DOES NOT CHANGE — only where it sits. These are the exact
    // conditions a03b2d9b, e440991b and 9066bd6c each shipped; the whole point of the round is that the
    // reporter asked for less width, not fewer rules.
    expect(menuSlot, 'Reprocess: processed + multi-cycle').toMatch(
      /b\.status === 'processed' && multiCycleOn && \(/,
    );
    expect(menuSlot, 'Remove Employee: processed + multi-cycle + the reset risk switch').toMatch(
      /b\.status === 'processed' && multiCycleOn && resetOn && \(/,
    );
    expect(menuSlot, 'Reset Payroll: processed + the reset risk switch').toMatch(
      /b\.status === 'processed' && resetOn && \(/,
    );
    expect(menuSlot).toContain("tb('reprocessAction')");
    expect(menuSlot).toContain("tb('removeAction')");
    expect(menuSlot).toContain("tb('resetPayroll')");
  });

  it('Reset keeps its confirmation dialog, its batch id and the reason field — the move is presentational', () => {
    // A destructive payroll action that lost its ConfirmSubmit on the way into a dropdown would be a far
    // worse defect than the width it was moved to fix.
    expect(menuSlot).toMatch(/<form action=\{resetAction\}>/);
    expect(menuSlot).toContain('<input type="hidden" name="batchId" value={b.id} />');
    expect(menuSlot).toMatch(/<ConfirmSubmit/);
    expect(menuSlot).toMatch(/reasonField=\{\{/);
    expect(menuSlot).toContain("confirmLabel={tb('resetConfirm')}");
  });

  it('View stays permanently visible, and the DRAFT row keeps Continue and Delete where they were', () => {
    // The reporter's own words: View is the action used on every row. Draft rows were never the problem —
    // they carry two controls, not four — so they are deliberately untouched.
    expect(menuSlot, 'View was hidden behind the menu').not.toContain("t('rowView')");
    expect(menuSlot, 'Continue was hidden behind the menu').not.toContain("t('rowContinue')");
    expect(menuSlot, 'Delete draft was hidden behind the menu').not.toContain("t('deleteDraft')");
    expect(LIST).toContain("t('rowView')");
    expect(LIST).toContain("t('rowContinue')");
    expect(LIST).toMatch(/<form action=\{deleteDraftBatchAction\}>/);
  });

  it('the menu trigger is labelled from the catalogue, resolved on the SERVER', () => {
    // Same convention as CollapsibleCardSection: the caller does the literal t('…') lookup so the i18n
    // coverage check keeps seeing a static key at the call site, and the island takes a plain string.
    expect(LIST).toContain("moreLabel={t('rowMoreActions')}");
  });
});

describe('65e2d5de · B — the island places actions; it never decides which exist', () => {
  it('it takes rendered children and knows nothing about a payroll status', () => {
    // If this island ever grew a status prop it could start disagreeing with the server page about who may
    // reset a run — two surfaces, one of them not the authority. It cannot: it never sees one.
    expect(ISLAND).toMatch(/children\?: ReactNode/);
    for (const forbidden of ['processed', 'multiCycleOn', 'resetOn', 'batchId', 'b.status']) {
      expect(ISLAND, `the row-action island started reading payroll state: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('a lone surviving action renders inline — a menu of one costs a click and saves no width', () => {
    expect(ISLAND).toMatch(/Children\.toArray\(children\)/);
    expect(ISLAND).toMatch(/if \(items\.length === 0\) return null;/);
    expect(ISLAND).toMatch(/if \(items\.length === 1\) return <>\{items\[0\]\}<\/>;/);
  });

  it('the panel is positioned FIXED, or the table’s own overflow wrapper would clip it shut', () => {
    // The Actions cell sits inside `<div className="overflow-x-auto">`. Per CSS, a non-visible overflow on
    // one axis makes the other `auto` too, so an absolutely-positioned dropdown is clipped by that wrapper
    // — the menu would open into a scroll region. This is not a style preference; it is the bug.
    expect(ISLAND).toMatch(/getBoundingClientRect\(\)/);
    expect(ISLAND).toMatch(/className="fixed z-50/);
    expect(LIST).toContain('<div className="overflow-x-auto">');
  });
});

describe('65e2d5de · C — Recalculation History arrives closed, the fresh result does not', () => {
  it('the history card is wrapped in the shared fold, keyed on its own cookie', () => {
    expect(REPROCESS_PAGE).toMatch(/import \{ CollapsibleCardSection \} from '@\/components\/collapsible-card-section'/);
    expect(REPROCESS_PAGE).toMatch(/<CollapsibleCardSection/);
    expect(REPROCESS_PAGE).toContain("const HISTORY_OPEN_COOKIE = 'payroll-reprocess-history';");
    expect(REPROCESS_PAGE).toContain('cookieKey={HISTORY_OPEN_COOKIE}');
    expect(REPROCESS_PAGE).toContain('defaultOpen={historyOpen}');
    // The count stays on the summary bar, so a closed card still says how much is behind it.
    expect(REPROCESS_PAGE).toContain('count={earlier.length}');
    expect(REPROCESS_PAGE).toContain("toggleLabel={t('reprocessHistoryToggle')}");
  });

  it('CLOSED by default — the polarity is the request, and it is the opposite of every other panel cookie', () => {
    // The payroll transaction screens read `!== '0'` because their employee panel opens by default. Copying
    // that here would ship a "fold" that is always open: it would pass every other case in this file, and
    // read to the reporter as nothing having changed.
    expect(REPROCESS_PAGE).toContain("(await cookies()).get(HISTORY_OPEN_COOKIE)?.value === '1'");
    expect(REPROCESS_PAGE).not.toContain("(await cookies()).get(HISTORY_OPEN_COOKIE)?.value !== '0'");
  });

  it('exactly ONE fold on the page, and it is the history — not the job the operator just submitted', () => {
    // The result panel above is what somebody came back for after pressing the button. Folding it away
    // would answer a submit with a collapsed bar.
    expect((REPROCESS_PAGE.match(/<CollapsibleCardSection/g) ?? []).length).toBe(1);
    const historyBlock = REPROCESS_PAGE.slice(REPROCESS_PAGE.indexOf('{earlier.length > 0 && ('));
    expect(historyBlock).toMatch(/<CollapsibleCardSection/);
    expect(historyBlock).toContain("title={t('disclosureTitle')}");
    const beforeHistory = REPROCESS_PAGE.slice(0, REPROCESS_PAGE.indexOf('{earlier.length > 0 && ('));
    expect(beforeHistory, 'the fresh job result was folded away too').not.toMatch(/<CollapsibleCardSection/);
    expect(beforeHistory, 'sanity: the result panel is still above the history').toContain(
      "thisJob.status === 'completed'",
    );
  });

  it('nothing was deleted — the disclosure read and every line of the card survive', () => {
    expect(REPROCESS_PAGE).toContain('listRecomputeDisclosure');
    for (const key of ['disclosureRevision', 'disclosureCauseHeading', 'disclosureBasesHeading', 'reprocessHistoryNote']) {
      // Some take ICU arguments, so the key itself is the token to look for, not a bare `t('…')`.
      expect(REPROCESS_PAGE, `the fold cost the card its ${key} line`).toContain(`t('${key}'`);
    }
  });
});

describe('65e2d5de · D — the reprocess search cannot shrink the submitted set', () => {
  it('the ticked-but-hidden ids ride hidden inputs, over BOTH groups', () => {
    // The failure this prevents is silent: the review names three people, one id is posted, and the screen
    // agrees with itself throughout. Proved by FormData in the dom test; pinned at the source here because
    // the contract spans the review block and the form, and either half alone passes whatever the other does.
    expect(REPROCESS_FORM).toMatch(/const pickedOffscreen = picked\.filter\(\(e\) => !visibleIds\.has\(e\.employmentId\)\)/);
    expect(REPROCESS_FORM).toMatch(
      /pickedOffscreen\.map\(\(e\) => \(\s*<input key=\{e\.employmentId\} type="hidden" name="employmentIds" value=\{e\.employmentId\} \/>/,
    );
    // visibleIds spans the additions as well as the people already paid, or an ADD hidden by the search
    // would be dropped while the review still promises it.
    expect(REPROCESS_FORM).toMatch(/new Set\(\[\.\.\.visibleEmployees, \.\.\.visibleAdditions\]\.map\(\(e\) => e\.employmentId\)\)/);
  });

  it('both tables render the FILTERED rows, and Select all takes only what is on screen', () => {
    expect(REPROCESS_FORM).toContain('{visibleAdditions.map((c) => {');
    expect(REPROCESS_FORM).toContain('{visibleEmployees.map((e) => {');
    expect(REPROCESS_FORM).toContain('setSelected(new Set(visibleEmployees.map((e) => e.employmentId)))');
    // The match is on employee ID **or** name, partial and case-insensitive — the reporter's ask, and the
    // same predicate remove-form.tsx uses.
    expect(REPROCESS_FORM).toMatch(
      /\(e\.employeeCode \?\? ''\)\.toLowerCase\(\)\.includes\(needle\) \|\| e\.name\.toLowerCase\(\)\.includes\(needle\)/,
    );
  });

  it('an empty run and an empty search result say different things', () => {
    expect(REPROCESS_FORM).toContain("employees.length === 0 ? t('reprocessNoEmployees') : t('reprocessNoMatches')");
  });
});

describe('65e2d5de · E — the new copy resolves in every catalogue', () => {
  const NEW_KEYS = [
    ['payroll.list', 'rowMoreActions'],
    ['payroll.batch', 'reprocessHistoryToggle'],
    ['payroll.batch', 'reprocessSearchPlaceholder'],
    ['payroll.batch', 'reprocessNoMatches'],
  ] as const;

  it.each(NEW_KEYS)('%s.%s exists in all six locales and takes no ICU argument', (ns, key) => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const value = `${ns}.${key}`
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);
      expect(typeof value, `${loc} missing ${ns}.${key}`).toBe('string');
      expect((value as string).length, `${loc} blank ${ns}.${key}`).toBeGreaterThan(0);
      // Every one of these is read through a bare t(), and a message carrying `{…}` THROWS at render
      // rather than degrading — it would take a dev server to notice.
      expect(value as string, `${loc} ${ns}.${key} carries an ICU placeholder`).not.toMatch(/\{/);
    }
  });
});
