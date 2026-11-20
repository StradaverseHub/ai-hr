/**
 * Direct Superior (feedback dce55aff) — the Personnel (Admin) Employment tab's Reporting Lines card is
 * replaced by a SINGLE Direct Superior field. The system already runs entirely on the administrative
 * reporting line (approvals, visibility, notifications, hierarchy walk), so this change is a UI
 * simplification over the same engine:
 *
 *  - ONE searchable field (Employee ID or name via the shared Combobox — its option labels carry
 *    "EMP-0008 – John Tan" so type-ahead matches both), one superior per employee.
 *  - HR chooses between recording a dated movement and amending the current administrative interval.
 *    Both maintain reporting history and record the actor through their respective audit owner.
 *  - Manager / Line Type / Effective From and the functional/project/dotted management UI are GONE;
 *    existing non-administrative rows stay in the data (org chart keeps rendering them for now).
 *  - Prior superiors remain visible in a compact read-only history disclosure
 *    (core/read.ts directSuperiorHistoryFor — closed administrative lines only).
 *
 * Service-level behavior (supersede on change, single active admin line) is additionally pinned by
 * test/slice0.test.ts "reporting lines — valid edge"; delegation flows by test/delegation-*.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { amendDirectSuperior, informationCorrectionHistory } from '../core/information-correction';
import { applyDueMovementsTx, createMovementEvent, editMovementEvent, movementDetail, movementHistory, reverseMovementEvent } from '../core/movement';
import { todayInKualaLumpur } from '../lib/hr-date';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, ReportingCycleError, setReportingLine } from '../core/org';
import { directSuperiorHistoryFor, reportingLinesFor } from '../core/read';
import { hasPersonnelPostedBinding } from './helpers/personnel-posted-binding';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const ACTIONS = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/actions.ts'),
  'utf8',
);
const FORM = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/direct-superior-change-form.tsx'),
  'utf8',
);
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// Same panel-body slicer as the other personnel tab guards — asserts WHICH panel a card renders in.
function panelBody(key: string): string {
  const start = PAGE.indexOf(`${key}: (`);
  if (start === -1) {
    const single = PAGE.indexOf(`${key}: `);
    return single === -1 ? '' : PAGE.slice(single, PAGE.indexOf('\n', single));
  }
  const from = PAGE.indexOf('(', start);
  return PAGE.slice(from, PAGE.indexOf('    ),', from) + 6);
}

describe('Direct Superior — UI drift guards (dce55aff)', () => {
  it('removes the Reporting Lines card and its manual controls outright', () => {
    // The const def, both old server actions, and the Line Type / Effective From controls are gone.
    expect(PAGE.includes('reportingLinesCard')).toBe(false);
    expect(PAGE.includes('addReportingLineAction')).toBe(false);
    expect(PAGE.includes('endReportingLineAction')).toBe(false);
    expect(PAGE.includes("t('lineType')")).toBe(false);
    expect(PAGE.includes('lineTypeFunctional')).toBe(false);
    expect(PAGE.includes('lineTypeProject')).toBe(false);
    expect(PAGE.includes('lineTypeDotted')).toBe(false);
    expect(PAGE.includes("t('reportingLineEffectiveFrom')")).toBe(false);
    expect(ACTIONS.includes('addReportingLineAction')).toBe(false);
    expect(ACTIONS.includes('endReportingLineAction')).toBe(false);
  });

  it('renders the Direct Superior card in the Employment (job) panel, delegations intact', () => {
    const job = panelBody('job');
    expect(job.includes('{directSuperiorCard}')).toBe(true);
    expect(job.includes('{delegationsCard}')).toBe(true);
    expect(PAGE.includes('id="section-direct-superior"')).toBe(true);
  });

  it('the field is the searchable Combobox posting superiorEmploymentId with the current line’s revision', () => {
    // Shared employee picker (search by Employee ID or name — the label carries "CODE – Name").
    expect(PAGE.match(/<Combobox\b/g) ?? []).toHaveLength(1);
    const from = PAGE.indexOf('<Combobox');
    const end = PAGE.indexOf('/>', from);
    expect(from).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(from);
    const picker = PAGE.slice(from, end + 2);
    expect(picker.length).toBeGreaterThan(100);
    expect(hasPersonnelPostedBinding(picker, 'employment.direct_superior_and_history.superioremploymentid', 'superiorEmploymentId')).toBe(true);
    expect(FORM).toContain('name="currentLineId"');
    expect(FORM).toContain('name="superiorChangeMode"');
    expect(FORM).toContain('name="superiorEffectiveDate"');
    expect(PAGE.includes('setDirectSuperiorAction')).toBe(true);
  });

  it('keeps prior superiors visible read-only (history disclosure) and the header ID + name', () => {
    expect(PAGE.includes('directSuperiorHistoryFor')).toBe(true);
    expect(PAGE.includes("t('directSuperiorHistory')")).toBe(true);
    // Employee Information header card: Direct Superior Employee ID + full name.
    expect(PAGE.includes("t('headerSuperior')")).toBe(true);
    expect(PAGE.includes('superiorLabel(currentSuperior.employeeCode, currentSuperior.name)')).toBe(true);
  });

  it('uses the correction and Movement commands for the two save choices', () => {
    const action = ACTIONS.slice(ACTIONS.indexOf('export async function setDirectSuperiorAction'));
    const body = action.slice(0, action.indexOf('\n}'));
    expect(body).toContain('amendDirectSuperior(session');
    expect(body).toContain('createMovementEvent(session');
    expect(body).toContain("kind: 'reportingLineChange'");
    expect(ACTIONS.includes('export async function addDelegationAction')).toBe(true);
    expect(ACTIONS.includes('export async function endDelegationAction')).toBe(true);
  });

  it('has every directSuperior* label in all six locales, old reporting-line keys removed', () => {
    const KEYS = [
      'directSuperiorTitle',
      'directSuperiorCurrent',
      'directSuperiorLabel',
      'directSuperiorNone',
      'directSuperiorSearch',
      'directSuperiorNoResults',
      'directSuperiorSave',
      'directSuperiorHistory',
      'directSuperiorHint',
    ];
    for (const loc of LOCALES) {
      const detail = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      )?.people?.detail;
      for (const k of KEYS) {
        expect(typeof detail?.[k], `messages/${loc}.json missing people.detail.${k}`).toBe('string');
        expect((detail[k] as string).length, `messages/${loc}.json people.detail.${k} empty`).toBeGreaterThan(0);
      }
      // The manual reporting-line vocabulary is retired from this namespace.
      for (const gone of ['reportingLines', 'lineType', 'addReportingLine', 'reportingLineEffectiveFrom']) {
        expect(detail?.[gone], `messages/${loc}.json still has people.detail.${gone}`).toBeUndefined();
      }
    }
  });
});

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('Direct Superior — service path (dce55aff)', () => {
  it('changing the superior CLOSEs the prior admin line and leaves exactly one active, with events', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Emp');
    const M1 = await hire(a, base, 'BossOne');
    const M2 = await hire(a, base, 'BossTwo');

    const first = await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M1.employmentId,
      lineType: 'administrative',
      validFrom: '2026-07-01',
    });
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M2.employmentId,
      lineType: 'administrative',
      validFrom: '2026-07-23',
    });

    // ONE active administrative superior — the new one — and the read carries the Employee ID column
    // the card/header render ("EMP-xxxx – Name").
    const lines = await reportingLinesFor(a, E.employmentId);
    const admins = lines.managers.filter((m) => m.lineType === 'administrative');
    expect(admins).toHaveLength(1);
    expect(admins[0].employmentId).toBe(M2.employmentId);
    expect('employeeCode' in admins[0]).toBe(true);

    // Prior line closed with the effective date of the change (effective-dating preserved underneath).
    const [old] = await withTenant(a, (tx) =>
      tx.select().from(schema.reportingLine).where(eq(schema.reportingLine.id, first.reportingLineId)),
    );
    expect(old.validTo).toBe('2026-07-23');

    // Audit trail: previous superior superseded + new superior set, actor-stamped DomainEvents.
    const evs = await eventTypesFor(base.tenantId, first.reportingLineId);
    expect(evs).toContain('reporting-line.set');
    expect(evs).toContain('reporting-line.superseded');
  });

  it('an employee cannot be assigned as their own Direct Superior', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Selfie');
    await expect(
      setReportingLine(a, {
        subordinateEmploymentId: E.employmentId,
        managerEmploymentId: E.employmentId,
        lineType: 'administrative',
        validFrom: '2026-07-23',
      }),
    ).rejects.toThrow(ReportingCycleError);
  });

  it('a circular chain is refused (A→B→C, then C→A)', async () => {
    const a = adminCtx(base);
    const A = await hire(a, base, 'Alpha');
    const B = await hire(a, base, 'Bravo');
    const C = await hire(a, base, 'Charlie');
    await setReportingLine(a, {
      subordinateEmploymentId: A.employmentId,
      managerEmploymentId: B.employmentId,
      lineType: 'administrative',
      validFrom: '2026-07-01',
    });
    await setReportingLine(a, {
      subordinateEmploymentId: B.employmentId,
      managerEmploymentId: C.employmentId,
      lineType: 'administrative',
      validFrom: '2026-07-01',
    });
    await expect(
      setReportingLine(a, {
        subordinateEmploymentId: C.employmentId,
        managerEmploymentId: A.employmentId,
        lineType: 'administrative',
        validFrom: '2026-07-01',
      }),
    ).rejects.toThrow(ReportingCycleError);
  });

  it('directSuperiorHistoryFor lists ONLY closed administrative lines, newest first', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Hist');
    const M1 = await hire(a, base, 'OldBoss');
    const M2 = await hire(a, base, 'MidBoss');
    const M3 = await hire(a, base, 'NewBoss');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M1.employmentId,
      lineType: 'administrative',
      validFrom: '2026-05-01',
    });
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M2.employmentId,
      lineType: 'administrative',
      validFrom: '2026-06-01',
    });
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M3.employmentId,
      lineType: 'administrative',
      validFrom: '2026-07-01',
    });
    // A functional line (legacy data) must NOT appear in the superior history even once closed.
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M1.employmentId,
      lineType: 'functional',
      validFrom: '2026-05-01',
    });
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M2.employmentId,
      lineType: 'functional',
      validFrom: '2026-06-15',
    });

    const hist = await directSuperiorHistoryFor(a, E.employmentId);
    expect(hist.map((h) => h.managerEmploymentId)).toEqual([M2.employmentId, M1.employmentId]);
    expect(hist[0].validFrom).toBe('2026-06-01');
    expect(hist[0].validTo).toBe('2026-07-01');
    expect(hist[1].validTo).toBe('2026-06-01');
    // The OPEN line (current superior M3) is not history.
    expect(hist.some((h) => h.managerEmploymentId === M3.employmentId)).toBe(false);
  });
});

describe('Changed Direct Superior movement', () => {
  it('presents older tagged history and an official dated change with independent before and after values', async () => {
    const ctx = adminCtx(base);
    const employee = (await hire(ctx, base, 'LegacyWorker')).employmentId;
    const first = (await hire(ctx, base, 'LegacyFirst')).employmentId;
    const second = (await hire(ctx, base, 'LegacySecond')).employmentId;
    const third = (await hire(ctx, base, 'DatedThird')).employmentId;
    const line = { subordinateEmploymentId: employee, lineType: 'administrative' } as const;
    await setReportingLine(ctx, { ...line, managerEmploymentId: first, validFrom: '2026-02-01' });
    await setReportingLine(ctx, { ...line, managerEmploymentId: second, validFrom: '2026-03-01',
      movement: { type: 'reportingLineChange', groupId: '260fdd53-0863-4347-8313-aec786f326dd' } });
    await createMovementEvent(ctx, { employmentId: employee, kind: 'reportingLineChange',
      effectiveDate: '2026-04-01', managerEmploymentId: third });

    const changes = (await movementHistory(ctx, employee)).filter(row => row.kind === 'reportingLineChange');
    expect(changes.map(row => row.effectiveDate)).toEqual(['2026-03-01', '2026-04-01']);
    expect(changes.map(row => row.superiorChange)).toEqual([
      { before: { kind: 'named', name: 'LegacyFirst' }, after: { kind: 'named', name: 'LegacySecond' } },
      { before: { kind: 'named', name: 'LegacySecond' }, after: { kind: 'named', name: 'DatedThird' } },
    ]);
    expect((await movementDetail(ctx, employee, changes[0].id))?.superiorChange).toEqual(changes[0].superiorChange);

    await editMovementEvent(ctx, { employmentId: employee, movementId: changes[1].id,
      kind: 'reportingLineChange', effectiveDate: '2026-04-03', managerEmploymentId: first,
      reason: 'Correct the date and assignee' });
    const edited = (await movementHistory(ctx, employee)).filter(row => row.kind === 'reportingLineChange' && !row.reversed);
    expect(edited.map(row => row.effectiveDate)).toEqual(['2026-03-01', '2026-04-03']);
    expect(edited[1].superiorChange?.after).toEqual({ kind: 'named', name: 'LegacyFirst' });
  });

  it('amends the current interval with audit evidence and rejects a stale line revision', async () => {
    const ctx = adminCtx(base);
    const employee = (await hire(ctx, base, 'AmendedWorker')).employmentId;
    const first = (await hire(ctx, base, 'OriginalBoss')).employmentId;
    const second = (await hire(ctx, base, 'CorrectedBoss')).employmentId;
    const { reportingLineId } = await setReportingLine(ctx, { subordinateEmploymentId: employee,
      lineType: 'administrative', managerEmploymentId: first, validFrom: '2026-02-01' });
    const correction = { employmentId: employee, expectedLineId: reportingLineId,
      managerEmploymentId: second, reason: 'Correct original assignment' };
    await amendDirectSuperior(ctx, correction);
    expect((await reportingLinesFor(ctx, employee)).managers[0]?.employmentId).toBe(second);
    expect((await movementHistory(ctx, employee)).map(row => row.kind)).toEqual(['hired']);
    const [audit] = await informationCorrectionHistory(ctx, employee);
    expect(audit.payload).toMatchObject({ effectiveOn: '2026-02-01', before: { managerEmploymentId: first },
      after: { managerEmploymentId: second }, reason: correction.reason });
    await expect(amendDirectSuperior(ctx, { ...correction, managerEmploymentId: null })).rejects.toThrow(/changed after/);
  });

  it('schedules a clear without changing Employment early and restores the assignment on Delete', async () => {
    const ctx = adminCtx(base);
    const employee = (await hire(ctx, base, 'ScheduledWorker')).employmentId;
    const manager = (await hire(ctx, base, 'CurrentBoss')).employmentId;
    await setReportingLine(ctx, { subordinateEmploymentId: employee, lineType: 'administrative',
      managerEmploymentId: manager, validFrom: '2026-02-01' });
    const tomorrow = todayInKualaLumpur(new Date(Date.now() + 86_400_000));
    await createMovementEvent(ctx, { employmentId: employee, kind: 'reportingLineChange',
      effectiveDate: tomorrow, managerEmploymentId: null });
    const pending = (await movementHistory(ctx, employee)).find(row => row.kind === 'reportingLineChange');
    expect(pending).toMatchObject({ status: 'pending', effectiveDate: tomorrow,
      superiorChange: { before: { kind: 'named', name: 'CurrentBoss' }, after: { kind: 'none' } } });
    expect((await reportingLinesFor(ctx, employee)).managers[0]?.employmentId).toBe(manager);
    await withTenant(ctx, tx => applyDueMovementsTx(tx, ctx, employee, tomorrow));
    const [closed] = await withTenant(ctx, tx => tx.select().from(schema.reportingLine)
      .where(and(eq(schema.reportingLine.subordinateEmploymentId, employee), eq(schema.reportingLine.managerEmploymentId, manager))));
    expect(closed.validTo).toBe(tomorrow);
    await reverseMovementEvent(ctx, { employmentId: employee, movementId: pending!.id, reason: 'Entered for the wrong employee' });
    const [restored] = await withTenant(ctx, tx => tx.select().from(schema.reportingLine)
      .where(eq(schema.reportingLine.id, closed.id)));
    expect(restored.validTo).toBeNull();
  });
});
