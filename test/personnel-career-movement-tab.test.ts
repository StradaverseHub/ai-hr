/**
 * Movement tab — Employment History redesign (78853b97, supersedes the 5296d984 relocation checks).
 * The Personnel (Admin) Movement tab is now ONE clean screen: an Employment History timeline
 * (employmentHistoryCard — a Hired-first projection over the domain_event ledger, header WITHOUT a row
 * count), a per-row View detail (movementDetailCard) and a single New Event entry point (newEventCard)
 * that folds in the former Transfer / Terminate / Blacklist boxes. This source-static suite (precedent:
 * test/personnel-attendance-tab.test.ts) guards the panel composition, the preserved deep-link anchor,
 * the static event-type label map (no dynamic t() keys) and the six-locale i18n coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCorrectedMovementRow, partitionMovementRows } from '../lib/movement-visibility';
import type { MovementHistoryRow, MovementReversal, MovementStatus } from '../core/movement';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const TABS = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
const NEW_EVENT = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-new-event.tsx'),
  'utf8',
);
// e6a144d4 — the event-type map, extracted out of the page so the Download Excel route shares it.
const KIND_LABEL = fs.readFileSync(path.resolve(__dirname, '../lib/movement-kind-label.ts'), 'utf8');
const EXPORT_ROUTE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-export/route.ts'),
  'utf8',
);
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// Slice out the panels object body so we can assert WHICH panel each card lives in, not just that the
// reference exists somewhere on the page (the const definitions also mention the card names).
function panelBody(key: string): string {
  const start = PAGE.indexOf(`${key}: (`);
  if (start === -1) {
    // Single-node panel form: `key: someCard,`
    const single = PAGE.indexOf(`${key}: `);
    return single === -1 ? '' : PAGE.slice(single, PAGE.indexOf('\n', single));
  }
  // Balance the fragment from the opening `(` to its matching `),`.
  const from = PAGE.indexOf('(', start);
  return PAGE.slice(from, PAGE.indexOf('    ),', from) + 6);
}

describe('Personnel — Movement tab / Employment History (78853b97)', () => {
  it('registers the career-movement tab in the tab strip, after Employment (job)', () => {
    expect(PAGE.includes("{ key: 'careerMovement', label: t('tabs.careerMovement') }")).toBe(true);
    const jobIdx = PAGE.indexOf("{ key: 'job', label: t('tabs.job') }");
    const cmIdx = PAGE.indexOf("{ key: 'careerMovement', label: t('tabs.careerMovement') }");
    expect(jobIdx).toBeGreaterThan(-1);
    expect(cmIdx).toBeGreaterThan(jobIdx);
    expect(TABS.includes("'careerMovement'")).toBe(true);
  });

  it('renders detail + new-event + edit + Employment History inside the careerMovement panel', () => {
    const cm = panelBody('careerMovement');
    expect(cm.includes('{movementDetailCard}')).toBe(true);
    expect(cm.includes('{newEventCard}')).toBe(true);
    // 66a63bd6 — Edit reuses the same comparison form, rendered above the timeline like the other two.
    expect(cm.includes('{editEventCard}')).toBe(true);
    expect(cm.includes('{employmentHistoryCard}')).toBe(true);
  });

  it('folds the old standalone boxes away — no Transfer/Terminate/Blacklist cards, no old history table', () => {
    // The const defs are deleted outright (New Event owns those flows via core/movement.ts).
    expect(PAGE.includes('transferTerminateCards')).toBe(false);
    expect(PAGE.includes('blacklistCard')).toBe(false);
    expect(PAGE.includes('assignmentHistoryCard')).toBe(false);
    // The Employment (job) tab keeps its master-data cards. (Feedback dce55aff replaced the
    // Reporting Lines card with the Direct Superior card.)
    const job = panelBody('job');
    expect(job.includes('{directSuperiorCard}')).toBe(true);
    expect(job.includes('{delegationsCard}')).toBe(true);
  });

  it('renames the header to Employment History WITHOUT a row count, and keeps the deep-link anchor', () => {
    // SectionHeader without a count prop — the "(12)" style badge is gone by design.
    expect(PAGE.includes("<SectionHeader title={t('movement.title')} />")).toBe(true);
    // Anchor id preserved byte-identical so existing deep links keep working.
    expect(PAGE.includes('id="section-assignment-history"')).toBe(true);
  });

  it('exposes the New Event entry point (hidden once terminated) and the key columns', () => {
    expect(PAGE.includes("t('movement.newEvent')")).toBe(true);
    expect(PAGE.includes('const canCreateMovement = admin && !emp.terminatedOn;')).toBe(true);
    for (const col of ['eventType', 'effectiveDate', 'endDate', 'remarks', 'action']) {
      expect(PAGE.includes(`t('movement.columns.${col}')`), `missing column ${col}`).toBe(true);
    }
    expect(PAGE.includes("t('movement.view')")).toBe(true);
  });

  // e6a144d4 — the switch MOVED to lib/movement-kind-label.ts so the Download Excel route prints the same
  // caption the screen does. The invariant is unchanged (static keys, humanized fallback, no dynamic
  // template) — it is now asserted where the map actually lives, plus a guard that the page did not keep a
  // second copy of it.
  it('labels event types through a STATIC key map with a humanized fallback (no dynamic t() keys)', () => {
    for (const kind of [
      'hired', 'transfer', 'promotion', 'demotion', 'increment', 'salaryAdjustment', 'confirmation',
      'probationExtension', 'secondment', 'actingPosition', 'resignation', 'termination', 'blacklist',
      'blacklistCleared', 'orgAssignmentChange', 'reportingLineChange', 'employmentTypeChange', 'gradeChange',
    ]) {
      expect(KIND_LABEL.includes(`t('movement.eventType.${kind}')`), `missing static label for ${kind}`).toBe(true);
    }
    // The fallback formatter for unknown/extensible kinds (never renders a raw key).
    expect(/default: return kind\.replace/.test(KIND_LABEL)).toBe(true);
    // No dynamic movement.eventType template in EITHER file.
    expect(KIND_LABEL.includes('movement.eventType.${')).toBe(false);
    expect(PAGE.includes('movement.eventType.${')).toBe(false);
    // The page calls the shared resolver and holds no second copy of the map.
    expect(PAGE.includes("from '@/lib/movement-kind-label'")).toBe(true);
    expect(PAGE.includes('movementKindLabelOf(kind, movementTypeByCode.get(kind)?.label, t)')).toBe(true);
    expect(PAGE.includes("t('movement.eventType.hired')"), 'the switch must not be duplicated on the page').toBe(false);
  });

  it('detail view renders the before/after comparison fields', () => {
    for (const f of ['company', 'businessUnit', 'department', 'position', 'grade', 'employmentType', 'manager', 'salary']) {
      expect(PAGE.includes(`t('movement.field.${f}')`), `missing comparison field ${f}`).toBe(true);
    }
    expect(PAGE.includes("t('movement.detail.beforeChanges')")).toBe(true);
    expect(PAGE.includes("t('movement.detail.afterChanges')")).toBe(true);
    expect(PAGE.includes("t('movement.detail.firstRecord')")).toBe(true);
  });

  // 08913328 — the New Event screen is now a Current / After comparison for the change kinds.
  it('the New Event island renders the Current / After comparison over the full requested field list', () => {
    for (const f of [
      'businessUnit', 'orgDivision', 'department', 'position', 'grade', 'employmentCategory',
      'orgRegion', 'orgBranch', 'orgTeam', 'orgSection', 'orgLine', 'orgBase', 'employmentType',
      'directSuperior', 'basicSalary', 'currency', 'payMode', 'paymentTerm',
    ]) {
      expect(NEW_EVENT.includes(`t('field.${f}')`), `missing comparison field ${f}`).toBe(true);
    }
    // Company is displayed but NOT editable here — moving legal entity is its own gated flow.
    expect(NEW_EVENT.includes("t('form.companyReadOnly')")).toBe(true);
    expect(NEW_EVENT.includes("t('form.currentInformation')")).toBe(true);
    expect(NEW_EVENT.includes("t('form.afterInformation')")).toBe(true);
    // The grid is only for the change kinds; lifecycle kinds keep their dedicated inputs.
    //
    // 476f23ed moved the decision from the selected CODE to the BEHAVIOUR that code carries: the event-type
    // list is now the tenant's Movement Settings catalogue, so a tenant's own "Redeployment" mapped onto
    // Transfer must render the Transfer grid. The invariant is unchanged — the grid follows the change
    // kinds — so the guard follows the construct that now expresses it.
    expect(NEW_EVENT.includes('const behaviour = behaviourOf(kind);')).toBe(true);
    expect(NEW_EVENT.includes('const isComparison = COMPARISON_KINDS.includes(behaviour);')).toBe(true);
  });

  it('has the comparison labels in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const mv = msg?.people?.detail?.movement ?? {};
      for (const f of [
        'orgDivision', 'employmentCategory', 'orgRegion', 'orgBranch', 'orgTeam', 'orgSection',
        'orgLine', 'orgBase', 'directSuperior', 'basicSalary', 'currency', 'payMode', 'paymentTerm',
      ]) {
        expect(typeof mv.field?.[f], `messages/${loc}.json missing movement.field.${f}`).toBe('string');
      }
      for (const k of ['currentInformation', 'afterInformation', 'comparisonHint', 'companyReadOnly']) {
        expect(typeof mv.form?.[k], `messages/${loc}.json missing movement.form.${k}`).toBe('string');
      }
    }
  });

  // 66a63bd6 — Edit + Rollback on each Employment History row. 10fcf6df renamed the second affordance
  // from Delete: the service has reversed rather than erased since 66a63bd6, and the label was the last
  // thing still promising a deletion the system never performed.
  it('offers View / Edit / Roll Back on the Action column, gated by the service flags', () => {
    expect(PAGE.includes("t('movement.edit')")).toBe(true);
    expect(PAGE.includes("t('movement.rollback')")).toBe(true);
    // The affordance reads the SAME flags the service refuses on — no second copy of the rule here.
    expect(PAGE.includes('m.canEdit')).toBe(true);
    expect(PAGE.includes('m.canReverse')).toBe(true);
    expect(PAGE.includes('m.payrollLocked')).toBe(true);
    // Rollback is confirmed, and collects the optional "reason for the change" the audit trail asks for.
    expect(PAGE.includes("t('movement.rollbackConfirmTitle')")).toBe(true);
    expect(PAGE.includes("reasonField={{ name: 'reason'")).toBe(true);
    expect(PAGE.includes('reverseMovementEventAction')).toBe(true);
  });

  // 10fcf6df — the word "Delete" is gone from the Employment History affordance. Scoped to the movement
  // namespace: other cards on this page (emergency contacts, qualifications, documents) genuinely delete
  // and keep their own delete labels.
  it('no longer offers a Delete on a movement row', () => {
    expect(PAGE.includes("t('movement.delete')")).toBe(false);
    expect(PAGE.includes("t('movement.deleteConfirm")).toBe(false);
  });

  // 95d17761 superseded the second half of this guard. The BADGES stay — a rolled-back movement is still
  // rendered as reversed, never erased — but the row is now off the default list behind a Show link. What
  // must never come back is a filter applied to the PROJECTION: `movements` stays the complete history,
  // and it is the list the detail lookup, the Edit lookup and the pending banner all keep reading.
  it('shows a rolled-back movement as reversed rather than removing the record', () => {
    expect(PAGE.includes("t('movement.reversedBadge')")).toBe(true);
    expect(PAGE.includes("t('movement.correctedBadge')")).toBe(true);
    // The projection is read whole and never narrowed at the source.
    expect(PAGE.includes('await movementHistory(s, employmentId)')).toBe(true);
    // The Edit lookup resolves against the FULL history, so a hidden row is still reachable by id.
    expect(PAGE.includes('movements.find((m) => m.id === spEditMovement')).toBe(true);
    // …and the pending banner on the Employment tab reads the full history too.
    expect(PAGE.includes("movements\n    .filter((m) => m.status === 'pending')")).toBe(true);
  });

  it('the Edit form is the same island, posting to the correction action', () => {
    expect(NEW_EVENT.includes('editMovementEventAction')).toBe(true);
    expect(NEW_EVENT.includes("t('form.editHint')")).toBe(true);
    expect(NEW_EVENT.includes("t('form.saveCorrection')")).toBe(true);
    expect(NEW_EVENT.includes("t('form.correctionReason')")).toBe(true);
    // The processed-payroll notice must reach the user BEFORE they save, never after.
    expect(NEW_EVENT.includes("t('form.payrollWarning')")).toBe(true);
  });

  it('has the correction labels in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const mv = msg?.people?.detail?.movement ?? {};
      for (const k of [
        'edit', 'rollback', 'reversedBy', 'editTitle', 'reversedBadge', 'correctedBadge',
        'rollbackConfirmTitle', 'rollbackConfirmDescription', 'rollbackConfirmPayroll',
        'correctionReasonLabel', 'payrollLocked',
      ]) {
        expect(typeof mv[k], `messages/${loc}.json missing movement.${k}`).toBe('string');
      }
      for (const k of ['editHint', 'payrollWarning', 'correctionReason', 'saveCorrection']) {
        expect(typeof mv.form?.[k], `messages/${loc}.json missing movement.form.${k}`).toBe('string');
      }
    }
  });

  it('has the movement labels in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      );
      const detail = msg?.people?.detail;
      for (const key of ['tabs.careerMovement', 'movement.title', 'movement.newEvent', 'movement.view']) {
        const val = key.split('.').reduce((o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), detail);
        expect(typeof val, `messages/${loc}.json missing people.detail.${key}`).toBe('string');
        expect((val as string).length, `messages/${loc}.json people.detail.${key} is empty`).toBeGreaterThan(0);
      }
      // Every shipped event-type label exists in every locale.
      const types = detail?.movement?.eventType ?? {};
      for (const kind of [
        'hired', 'transfer', 'promotion', 'demotion', 'increment', 'salaryAdjustment', 'confirmation',
        'probationExtension', 'secondment', 'actingPosition', 'resignation', 'termination', 'blacklist',
        'blacklistCleared', 'orgAssignmentChange', 'reportingLineChange', 'employmentTypeChange', 'gradeChange',
      ]) {
        expect(typeof types[kind], `messages/${loc}.json missing movement.eventType.${kind}`).toBe('string');
      }
    }
  });
});

/**
 * 95d17761 — "Hide corrected movement records by default".
 *
 * A HARD DELETE STAYS REFUSED (9064cffb settled it with the reporter, and Employment History is a
 * projection over the append-only ledger — there is no row to delete). This is a VIEW change and only a
 * view change: nothing is written, nothing is deleted, no figure moves. The rule that decides what the
 * table draws is a pure function, so it is asserted DIRECTLY here rather than pattern-matched out of the
 * page source; the source guards below only pin the wiring the pure function cannot see.
 */
const rev = (over: Partial<MovementReversal> = {}): MovementReversal => ({
  at: new Date('2026-08-01T02:00:00Z'),
  reason: 'Keyed against the wrong employee',
  corrected: false,
  cancelled: false,
  by: 'HR Admin',
  ...over,
});
type Row = Pick<MovementHistoryRow, 'id' | 'status' | 'reversed'>;
const row = (id: string, status: MovementStatus, reversed: MovementReversal | null = null): Row => ({
  id,
  status,
  reversed,
});

describe('95d17761 — the Movement tab hides corrected records by default', () => {
  // The worst live profile measured on production, 7 Aug: 7 rows of which 3 are dead — a reversed
  // transfer, a corrected increment (the reverse half of an edit) and a superseded scheduled promotion.
  const productionShapedHistory: Row[] = [
    row('hired', 'applied'),
    row('confirmation', 'applied'),
    row('transfer', 'reversed', rev()),
    row('increment-corrected', 'reversed', rev({ corrected: true })),
    row('salaryAdjustment', 'applied'),
    row('promotion-superseded', 'superseded'),
    row('future-promotion', 'pending'),
  ];

  it('the DEFAULT view omits reversed, corrected, cancelled and superseded rows', () => {
    const { visible } = partitionMovementRows(productionShapedHistory, false);
    expect(visible.map((r) => r.id)).toEqual([
      'hired',
      'confirmation',
      'salaryAdjustment',
      'future-promotion',
    ]);
    // Every one of the four dead shapes is individually recognised — not just the two on this profile.
    expect(isCorrectedMovementRow(row('x', 'reversed', rev())), 'rolled back').toBe(true);
    expect(isCorrectedMovementRow(row('x', 'reversed', rev({ corrected: true }))), 'corrected').toBe(true);
    expect(isCorrectedMovementRow(row('x', 'reversed', rev({ cancelled: true }))), 'cancelled').toBe(true);
    expect(isCorrectedMovementRow(row('x', 'superseded')), 'superseded').toBe(true);
    expect(isCorrectedMovementRow(row('x', 'applied')), 'applied').toBe(false);
  });

  it('the count line names the right number — what was removed, not what was kept', () => {
    expect(partitionMovementRows(productionShapedHistory, false).hiddenCount).toBe(3);
    // …and it is exactly the rows the table stopped drawing.
    const { visible, hiddenCount } = partitionMovementRows(productionShapedHistory, false);
    expect(hiddenCount).toBe(productionShapedHistory.length - visible.length);
    // A clean career hides nothing, so the line never renders on a profile with no corrections.
    expect(partitionMovementRows([row('hired', 'applied')], false).hiddenCount).toBe(0);
  });

  it('showCorrected=1 restores every row, exactly as the list rendered before this item', () => {
    const { visible, hiddenCount } = partitionMovementRows(productionShapedHistory, true);
    expect(visible.map((r) => r.id)).toEqual(productionShapedHistory.map((r) => r.id));
    // Nothing is hidden, so the count line gives way to the Hide link.
    expect(hiddenCount).toBe(0);
  });

  it('a PENDING row is never hidden — it has not happened yet and HR still has to see it', () => {
    // Dated in the future, live: kept in the default view.
    expect(isCorrectedMovementRow(row('x', 'pending'))).toBe(false);
    expect(partitionMovementRows([row('p', 'pending')], false)).toEqual({
      visible: [row('p', 'pending')],
      hiddenCount: 0,
    });
    // A pending movement that was CANCELLED is a different thing: statusOfRow reports it as `reversed`
    // (the reversal wins over every other status), the badge says Cancelled, and it DOES drop off.
    expect(isCorrectedMovementRow(row('c', 'reversed', rev({ cancelled: true })))).toBe(true);
  });

  it('an all-dead history hides everything and leaves nothing to draw', () => {
    const allDead: Row[] = [
      row('a', 'reversed', rev()),
      row('b', 'reversed', rev({ corrected: true })),
      row('c', 'superseded'),
    ];
    const { visible, hiddenCount } = partitionMovementRows(allDead, false);
    expect(visible).toEqual([]);
    expect(hiddenCount).toBe(3);
    // Which is why the page must render the empty message AND the count line, not a bare table head.
    expect(PAGE.includes("t('movement.empty')")).toBe(true);
    expect(PAGE.includes('visibleMovements.length === 0 &&')).toBe(true);
    // The two blocks are siblings, each with its own condition — the count line is NOT nested inside the
    // rows branch, so an all-dead history still gets its Show link.
    expect(PAGE.includes('correctedMovementCount > 0 &&')).toBe(true);
  });

  it('SOURCE GUARD: the table draws the filtered list; the detail view still resolves a hidden row by id', () => {
    // The table body maps the FILTERED list…
    expect(PAGE.includes('{visibleMovements.map((m) => (')).toBe(true);
    expect(PAGE.includes('{movements.map((m) => (')).toBe(false);
    // …computed by the shared pure rule, never re-implemented inline on the page.
    expect(PAGE.includes('partitionMovementRows(')).toBe(true);
    expect(PAGE.includes("const showCorrectedMovements = spShowCorrected === '1';")).toBe(true);
    // The detail view goes straight to the service by id and never looks in the rendered list, so a link
    // to a hidden row from the audit trail keeps working (asserted for real against the DB in
    // test/movement-rollback.test.ts).
    expect(PAGE.includes('await movementDetail(s, employmentId, spMovement)')).toBe(true);
  });

  it('SOURCE GUARD: Show / Hide preserve the tab and every other search param', () => {
    expect(PAGE.includes("t('movement.showCorrected')")).toBe(true);
    expect(PAGE.includes("t('movement.hideCorrected')")).toBe(true);
    // Built from the CURRENT query string rather than a hand-written href, so nothing else is dropped.
    expect(PAGE.includes('const movementVisibilityHref = (show: boolean): string')).toBe(true);
    expect(PAGE.includes('Object.entries(rawSearchParams)')).toBe(true);
    expect(PAGE.includes("qs.set('tab', 'careerMovement');")).toBe(true);
    expect(PAGE.includes("qs.set('showCorrected', '1');")).toBe(true);
    expect(PAGE.includes('href={movementVisibilityHref(true)}')).toBe(true);
    expect(PAGE.includes('href={movementVisibilityHref(false)}')).toBe(true);
    // The param is declared on the page's searchParams contract (a stray key would be silently dropped).
    expect(PAGE.includes('showCorrected?: string;')).toBe(true);
  });

  it('SOURCE GUARD: correctedHidden is called WITH its {count} argument (an ICU contract, not a label)', () => {
    // next-intl throws at render for a message with a placeholder called without arguments — a 200 and a
    // green tsc would both still pass, so the call shape is pinned here.
    expect(PAGE.includes("t('movement.correctedHidden', { count: correctedMovementCount })")).toBe(true);
    const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'));
    expect(en.people.detail.movement.correctedHidden).toContain('{count, plural,');
  });

  it('the hide/show vocabulary exists in all six locales, with the count placeholder intact', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const mv = msg?.people?.detail?.movement ?? {};
      for (const k of ['correctedHidden', 'showCorrected', 'hideCorrected', 'empty']) {
        expect(typeof mv[k], `messages/${loc}.json missing movement.${k}`).toBe('string');
        expect((mv[k] as string).length, `messages/${loc}.json movement.${k} is empty`).toBeGreaterThan(0);
      }
      // A locale that lost the placeholder would render a fixed number in every language but English.
      expect(mv.correctedHidden, `messages/${loc}.json movement.correctedHidden lost {count}`).toContain(
        '{count, plural,',
      );
    }
  });
});

/**
 * e6a144d4 — "Download Excel on the Movement tab".
 *
 * The builder itself is unit-tested in test/movement-export.test.ts. What only source can show is the
 * WIRING the reporter approved on the mockup: a Download Excel control beside New Event, and an action bar
 * that survives termination while New Event does not.
 */
describe('Movement tab — Download Excel (e6a144d4)', () => {
  /** The Employment History card's action bar, from the card's opening paren to the table container. */
  const actionBar = (() => {
    const from = PAGE.indexOf('const employmentHistoryCard = (');
    const to = PAGE.indexOf('<div className="overflow-x-auto">', from);
    expect(from, 'employmentHistoryCard not found').toBeGreaterThan(-1);
    expect(to, 'the table container not found').toBeGreaterThan(from);
    return PAGE.slice(from, to);
  })();

  /** The body of the `{canCreateMovement && ( … )}` block inside the bar, paren-balanced. */
  const gateBlock = (() => {
    const start = actionBar.indexOf('{canCreateMovement && (');
    if (start === -1) return '';
    let i = actionBar.indexOf('(', actionBar.indexOf('&&', start));
    let depth = 0;
    for (; i < actionBar.length; i++) {
      if (actionBar[i] === '(') depth++;
      else if (actionBar[i] === ')' && --depth === 0) break;
    }
    return actionBar.slice(start, i + 1);
  })();

  it('puts a Download Excel control in the Employment History action bar', () => {
    expect(actionBar.includes("t('movement.exportExcel')"), 'no Download Excel control on the card').toBe(true);
    // A plain link straight at the route: one click, the file downloads, no approval step and no waiting.
    expect(actionBar.includes('/movement-export')).toBe(true);
  });

  it('the bar is OUTSIDE the canCreateMovement gate, and only New Event is inside it', () => {
    // This is the whole of the terminated-employee promise: exit paperwork is exactly when the record is
    // asked for, so the bar must not vanish with the writer.
    expect(gateBlock, 'the canCreateMovement gate disappeared from the bar').not.toBe('');
    expect(gateBlock.includes("t('movement.newEvent')"), 'New Event must stay gated').toBe(true);
    expect(gateBlock.includes("t('movement.exportExcel')"), 'the download must NOT be gated').toBe(false);
    // …and the bar's own container is not itself wrapped in the gate.
    const barDiv = actionBar.indexOf('border-b border-border px-4 py-2');
    const gateAt = actionBar.indexOf('{canCreateMovement && (');
    expect(barDiv).toBeGreaterThan(-1);
    expect(barDiv, 'the action bar container is still inside the gate').toBeLessThan(gateAt);
  });

  it('the route reads the COMPLETE history — 95d17761 is a view filter and the file ignores it', () => {
    expect(EXPORT_ROUTE.includes('movementHistory(s, employmentId)')).toBe(true);
    // The one assertion this item turns on: applying the screen's filter here would silently drop the
    // rolled-back, cancelled, corrected and superseded events the reporter explicitly asked to keep.
    // Matched on the CALL and the IMPORT, not the bare name — the route names the filter in prose to say
    // why it does not use it, and a guard that forbids explaining itself would get the comment deleted.
    expect(EXPORT_ROUTE.includes('partitionMovementRows('), 'the download must not apply the view filter').toBe(false);
    expect(EXPORT_ROUTE.includes("from '@/lib/movement-visibility'")).toBe(false);
  });

  it('the route matches the page guard, reuses the shared writer, and writes nothing', () => {
    expect(EXPORT_ROUTE.includes('await scopedAdmin()')).toBe(true);
    expect(EXPORT_ROUTE.includes('await employeeDetail(s, employmentId)')).toBe(true);
    expect(EXPORT_ROUTE.includes("return new Response('Not found', { status: 404 })")).toBe(true);
    expect(/UUID_RE\s*=\s*\/\^\[0-9a-f\]\{8\}/.test(EXPORT_ROUTE)).toBe(true);
    // No fifth serializer — the shared ADR-0047 writer, exactly like the three export routes before it.
    expect(EXPORT_ROUTE.includes("from '@/lib/report-export'")).toBe(true);
    expect(EXPORT_ROUTE.includes('toXlsxReport(data)')).toBe(true);
    // Read-only: downloading a report mutates nothing, so no DomainEvent (the precedents' posture).
    expect(EXPORT_ROUTE.includes('appendEvent')).toBe(false);
    // A raw non-Latin-1 filename makes the Response constructor THROW and the download 500s.
    expect(EXPORT_ROUTE.includes("filename*=UTF-8''")).toBe(true);
    expect(EXPORT_ROUTE.includes('contentDisposition(data.filename, file.ext)')).toBe(true);
  });

  it('has the three new captions in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const mv = msg?.people?.detail?.movement ?? {};
      expect(typeof mv.exportExcel, `messages/${loc}.json missing movement.exportExcel`).toBe('string');
      expect((mv.exportExcel as string).length).toBeGreaterThan(0);
      for (const k of ['eventStatus', 'correctionReason']) {
        expect(typeof mv.columns?.[k], `messages/${loc}.json missing movement.columns.${k}`).toBe('string');
        expect((mv.columns[k] as string).length).toBeGreaterThan(0);
      }
    }
  });
});
