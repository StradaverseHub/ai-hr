/**
 * Direct Superior (feedback dce55aff) — the Personnel (Admin) Employment tab's Reporting Lines card is
 * replaced by a SINGLE Direct Superior field. The system already runs entirely on the administrative
 * reporting line (approvals, visibility, notifications, hierarchy walk), so this change is a UI
 * simplification over the same engine:
 *
 *  - ONE searchable field (Employee ID or name via the shared Combobox — its option labels carry
 *    "EMP-0008 – John Tan" so type-ahead matches both), one superior per employee.
 *  - Saving goes through the existing service path: setReportingLine supersedes (CLOSE + INSERT) the
 *    prior active administrative line, refuses self-assignment and cycles, and appends the
 *    reporting-line.set / .superseded DomainEvents (the audit trail: previous superior, new superior,
 *    actor, timestamp). Effective-dating stays internal — the screen no longer asks for dates.
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
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, ReportingCycleError, setReportingLine } from '../core/org';
import { directSuperiorHistoryFor, reportingLinesFor } from '../core/read';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const ACTIONS = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/actions.ts'),
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

  it('the field is the searchable Combobox posting superiorEmploymentId + the current-state hiddens', () => {
    // Shared employee picker (search by Employee ID or name — the label carries "CODE – Name").
    expect(PAGE.includes('name="superiorEmploymentId"')).toBe(true);
    expect(/<Combobox\s/.test(PAGE)).toBe(true);
    // The action's no-change guard + clear path need the current superior/line posted alongside.
    expect(PAGE.includes('name="currentSuperiorEmploymentId"')).toBe(true);
    expect(PAGE.includes('name="currentLineId"')).toBe(true);
    expect(PAGE.includes('setDirectSuperiorAction')).toBe(true);
  });

  it('keeps prior superiors visible read-only (history disclosure) and the header ID + name', () => {
    expect(PAGE.includes('directSuperiorHistoryFor')).toBe(true);
    expect(PAGE.includes("t('directSuperiorHistory')")).toBe(true);
    // Employee Information header card: Direct Superior Employee ID + full name.
    expect(PAGE.includes("t('headerSuperior')")).toBe(true);
    expect(PAGE.includes('superiorLabel(currentSuperior.employeeCode, currentSuperior.name)')).toBe(true);
  });

  it('the action writes ONLY the administrative line with validFrom = today (dates stay internal)', () => {
    const action = ACTIONS.slice(ACTIONS.indexOf('export async function setDirectSuperiorAction'));
    const body = action.slice(0, action.indexOf('\n}'));
    expect(body.includes("lineType: 'administrative'")).toBe(true);
    expect(body.includes('validFrom: today')).toBe(true);
    // Clearing the field ends the current line (hierarchy top); delegation actions are untouched.
    expect(body.includes('endReportingLine')).toBe(true);
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
