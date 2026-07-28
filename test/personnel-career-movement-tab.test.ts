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

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const TABS = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
const NEW_EVENT = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-new-event.tsx'),
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

  it('labels event types through a STATIC key map with a humanized fallback (no dynamic t() keys)', () => {
    for (const kind of [
      'hired', 'transfer', 'promotion', 'demotion', 'increment', 'salaryAdjustment', 'confirmation',
      'probationExtension', 'secondment', 'actingPosition', 'resignation', 'termination', 'blacklist',
      'blacklistCleared', 'orgAssignmentChange', 'reportingLineChange', 'employmentTypeChange', 'gradeChange',
    ]) {
      expect(PAGE.includes(`t('movement.eventType.${kind}')`), `missing static label for ${kind}`).toBe(true);
    }
    // The fallback formatter for unknown/extensible kinds (never renders a raw key).
    expect(/default: return kind\.replace/.test(PAGE)).toBe(true);
    // No dynamic movement.eventType template anywhere.
    expect(PAGE.includes('movement.eventType.${')).toBe(false);
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
    expect(NEW_EVENT.includes('const isComparison = COMPARISON_KINDS.includes(kind);')).toBe(true);
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

  // 66a63bd6 — Edit + Delete (Rollback) on each Employment History row.
  it('offers View / Edit / Delete on the Action column, gated by the service flags', () => {
    expect(PAGE.includes("t('movement.edit')")).toBe(true);
    expect(PAGE.includes("t('movement.delete')")).toBe(true);
    // The affordance reads the SAME flags the service refuses on — no second copy of the rule here.
    expect(PAGE.includes('m.canEdit')).toBe(true);
    expect(PAGE.includes('m.canReverse')).toBe(true);
    expect(PAGE.includes('m.payrollLocked')).toBe(true);
    // Delete is confirmed, and collects the optional "reason for the change" the audit trail asks for.
    expect(PAGE.includes("t('movement.deleteConfirmTitle')")).toBe(true);
    expect(PAGE.includes("reasonField={{ name: 'reason'")).toBe(true);
    expect(PAGE.includes('reverseMovementEventAction')).toBe(true);
  });

  it('shows a rolled-back movement as reversed rather than removing the row', () => {
    expect(PAGE.includes("t('movement.reversedBadge')")).toBe(true);
    expect(PAGE.includes("t('movement.correctedBadge')")).toBe(true);
    // The row is still rendered — nothing filters `movements` by the reversal.
    expect(PAGE.includes('movements.filter(')).toBe(false);
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
        'edit', 'delete', 'editTitle', 'reversedBadge', 'correctedBadge', 'deleteConfirmTitle',
        'deleteConfirmDescription', 'deleteConfirmPayroll', 'correctionReasonLabel', 'payrollLocked',
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
