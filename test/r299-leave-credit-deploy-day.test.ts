/**
 * 3fb1a611 (r299 fix pass) · DEPLOY DAY: A TENANT WITHOUT LEAVE CREDIT KEEPS MAIN'S BEHAVIOUR.
 *
 * Production — the only tenant — gets this build with the paid `toil` module OFF, no credits, a Replacement
 * Leave type coded `RL` with role `replacement` whose balances come from entitlement tables, and an Emergency
 * type `EL` (role `emergency`) that draws on Annual Leave. The adversarial verify found five places where the
 * build changed what that tenant sees on day one. Each is pinned here on BOTH arms: module off = main@60a40452's
 * behaviour, module on = the Leave Credit behaviour.
 *
 *   D3  Leave Adjustments and Leave import refuse Replacement Leave only while Leave Credit is live; the
 *       Adjustments screen drops the type from its picker and points at Leave Credit only then. An exempt
 *       (bootstrap/sweep) context reads "not live" — never a grant — and no sweep reaches those services.
 *   D4  editLeaveRequest refuses an Emergency type only where requestLeave DECOMPOSES it (no balance source).
 *   D8  the Apply form's Expiring soon figure exists only with the module (null without it).
 *   D9  with the module, Leave Balance Health reports a Replacement Leave entitlement table in force — and a
 *       Replacement Leave type with no table reads Ready rather than "no entitlement table".
 *
 * NOT HERE, AND WHY: D5 (switch Leave Credit off when the add-on is activated) was stopped — core/module-
 * activation.ts documents that an existing toil_policy row is left untouched on (re)activation, deliberately —
 * and D7 (a menu row for the lapsed-module wind-down) has no cheap signal in the root layout. Both are in the
 * round's report, not in code.
 *
 * FILE-LEVEL MOCKS (for the two page renders only; the services run against the real database): requireAdmin()
 * returns the module-level ADMIN; getTranslations is a REAL translator over messages/en.json that throws on a
 * missing or malformed message; AdjustmentForm (a client island) is replaced by a recorder of the props the page
 * hands it, which is exactly the contract under test; `settle()` awaits async server components before
 * renderToStaticMarkup, as test/reset-records-screen.test.ts does.
 *
 * NON-VACUITY (fix pass, from the committed checkpoint, each reverted in a scratch edit and restored with
 * `git checkout -- <file>`): see the round report — every arm below was watched failing with its fix removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let ADMIN: SessionContext;
const recorded = vi.hoisted(() => ({ adjustmentFormLeaveTypes: [] as { value: string; label: string }[][] }));
vi.mock('../lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz')>()),
  requireAdmin: async () => ADMIN,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});
// The page → client-island contract: record the leave types the Adjustments page offers, render nothing.
vi.mock('../components/leave/adjustment-form', () => ({
  AdjustmentForm: (p: { leaveTypes: { value: string; label: string }[] }) => {
    recorded.adjustmentFormLeaveTypes.push(p.leaveTypes);
    return null;
  },
}));

import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { editLeaveRequest, leaveTypeApplySummary, LeaveEditNotAllowedError, requestLeave } from '../core/leave';
import { applyLeaveAdjustmentBatch, LeaveAdjustmentError } from '../core/leave-adjustment';
import { commitLeaveImport, validateLeaveImport } from '../core/leave-import';
import { leaveCreditRegisterLive } from '../core/leave-credit-live';
import {
  EntitlementsResolutionFailedError,
  EntitlementsUnresolvedError,
  isModuleEnabled,
} from '../core/entitlements';
import { createEntitlementTemplate } from '../core/entitlement-template';
import { leaveTypeConfigHealth, type HealthLeaveType, type HealthTemplate } from '../lib/leave-config-health';
import { todayInKualaLumpur } from '../lib/hr-date';
import AdjustmentsPage from '../app/admin/leave-config/adjustments/page';
import BalanceHealthPage from '../app/admin/leave-config/balance-health/page';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const en = JSON.parse(read('messages/en.json'));
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nextMonday = (from: string) => {
  let d = from;
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
};

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r299dd_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

/** Production's shape: the customer's own Replacement Leave, coded RL and classified by ROLE. */
async function insertReplacementType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: 'RL',
      name: 'Replacement Leave',
      role: 'replacement',
      paid: true,
      counting: 'working_days',
      accrualMethod: 'full_upfront',
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** A context for the tenant with `toil` exactly as asked, and the precondition asserted (so no arm is vacuous). */
async function ctxWithToil(on: boolean): Promise<SessionContext> {
  await setModule(b.tenantId, 'toil', on ? 'active' : null);
  const ctx = await entitledCtx(b);
  expect(isModuleEnabled(ctx, 'toil'), `precondition: toil ${on ? 'on' : 'off'}`).toBe(on);
  return ctx;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  recorded.adjustmentFormLeaveTypes.length = 0;
});

// ─────────────────────────────── D3 · the entitlement question itself ───────────────────────────────

describe('D3 · leaveCreditRegisterLive — the service form, with ONE conversion', () => {
  it('answers the snapshot; an exempt context reads "not live" (never a grant); every other fault stays loud', () => {
    const on = { ...harnessSnapshot(b.tenantId), enabledModules: [...harnessSnapshot(b.tenantId).enabledModules, 'toil'] };
    const off = { ...harnessSnapshot(b.tenantId), enabledModules: harnessSnapshot(b.tenantId).enabledModules.filter((m) => m !== 'toil') };
    expect(leaveCreditRegisterLive({ tenantId: b.tenantId, entitlements: on })).toBe(true);
    expect(leaveCreditRegisterLive({ tenantId: b.tenantId, entitlements: off })).toBe(false);
    // Bootstrap / sweep marker: isModuleEnabled THROWS for it (a paid module), this answers NO.
    for (const marker of ['sweeps', 'seeding', 'provisioning'] as const) {
      expect(leaveCreditRegisterLive({ tenantId: b.tenantId, entitlementsExempt: marker })).toBe(false);
    }
    // …and only that: a forged marker, an unresolved context and a failed resolution are not converted.
    expect(() => leaveCreditRegisterLive({ tenantId: b.tenantId, entitlementsExempt: 'nope' as never })).toThrow(
      /Unrecognised entitlementsExempt marker/,
    );
    expect(() => leaveCreditRegisterLive({ tenantId: b.tenantId })).toThrow(EntitlementsUnresolvedError);
    expect(() => leaveCreditRegisterLive({ tenantId: b.tenantId, entitlementsError: 'pool timeout' })).toThrow(
      EntitlementsResolutionFailedError,
    );
  });

  it('no sweep, seed or provisioning path reaches the services that ask it (measured, so a new one is a decision)', () => {
    const names = /\b(applyLeaveAdjustmentBatch|validateLeaveImport|commitLeaveImport|leaveTypeApplySummary)\b/;
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : [],
      );
    const offenders = [...walk('scripts'), ...walk('db')].filter((f) => names.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────── D3 · Leave Adjustments (service) ───────────────────────────────

describe('D3 · Leave Adjustments on Replacement Leave: main without the module, refused with it', () => {
  const adjust = (ctx: SessionContext, leaveTypeIds: string[], employmentId: string) =>
    applyLeaveAdjustmentBatch(ctx, {
      leaveTypeIds,
      days: 1,
      reason: 'Correct the balance',
      effectiveOn: TODAY,
      targetMode: 'individual',
      employmentIds: [employmentId],
    });
  const rlRows = (employmentId: string, rl: string) =>
    owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, rl)));

  it('module OFF — the adjustment writes, alone and beside another type (main@60a40452)', async () => {
    const rl = await insertReplacementType();
    const emp = await hire('Adjusted Off');
    const ctx = await ctxWithToil(false);
    await expect(adjust(ctx, [rl], emp.employmentId)).resolves.toMatchObject({ written: 1 });
    await expect(adjust(ctx, [b.annualLeaveTypeId, rl], emp.employmentId)).resolves.toMatchObject({ written: 2 });
    expect(await rlRows(emp.employmentId, rl)).toHaveLength(2);
  });

  it('module ON — refused whole, pointing at Leave Credit, nothing written; another type still adjusts', async () => {
    const rl = await insertReplacementType();
    const emp = await hire('Adjusted On');
    const ctx = await ctxWithToil(true);
    for (const ids of [[rl], [b.annualLeaveTypeId, rl]]) {
      const attempt = adjust(ctx, ids, emp.employmentId);
      await expect(attempt).rejects.toBeInstanceOf(LeaveAdjustmentError);
      await expect(attempt).rejects.toThrow(/Leave Credit/);
    }
    expect(await rlRows(emp.employmentId, rl)).toHaveLength(0);
    await expect(adjust(ctx, [b.annualLeaveTypeId], emp.employmentId)).resolves.toMatchObject({ written: 1 });
  });
});

// ─────────────────────────────── D3 · Leave import (service) ───────────────────────────────

describe('D3 · Leave import on Replacement Leave: main without the module, refused with it', () => {
  async function fixture() {
    const rl = await insertReplacementType();
    const emp = await hire('Imported');
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp.employmentId));
    const records = [
      { employee_id: row.code!, leave_type: 'RL', transaction_type: 'adjustment', days: '2', effective_date: TODAY },
      { employee_id: row.code!, leave_type: 'ANNUAL', transaction_type: 'adjustment', days: '1', effective_date: TODAY },
    ];
    const rlRows = () =>
      owner.db
        .select({ id: schema.leaveLedger.id })
        .from(schema.leaveLedger)
        .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.leaveTypeId, rl)));
    return { records, rlRows };
  }

  it('module OFF — the RL row previews ready and is imported (main@60a40452)', async () => {
    const { records, rlRows } = await fixture();
    const ctx = await ctxWithToil(false);
    const preview = await validateLeaveImport(ctx, { records });
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[0].ok).toBe(true);
    expect(preview.rows[1].ok).toBe(true);
    await commitLeaveImport(ctx, { records });
    expect(await rlRows()).toHaveLength(1);
  });

  it('module ON — the RL row is an error naming Leave Credit and is not written; the Annual row still imports', async () => {
    const { records, rlRows } = await fixture();
    const ctx = await ctxWithToil(true);
    const preview = await validateLeaveImport(ctx, { records });
    expect(preview.rows[0].ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Leave Credit/);
    expect(preview.rows[1].ok).toBe(true);
    await commitLeaveImport(ctx, { records });
    expect(await rlRows()).toHaveLength(0);
  });

  it('a file with no Replacement Leave row never asks the entitlement question (an unresolved context still imports)', async () => {
    const { records } = await fixture();
    // No snapshot, no marker: leaveCreditRegisterLive would THROW for this context — so it must not be asked.
    const bare: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'] };
    const preview = await validateLeaveImport(bare, { records: [records[1]] });
    expect(preview.rows[0].ok).toBe(true);
  });
});

// ─────────────────────────────── D3 · Leave Adjustments (screen) ───────────────────────────────

const isAsync = (f: unknown) => typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  if (el.props && el.props.children !== undefined) return cloneElement(el, { children: await settle(el.props.children) });
  return node;
}
const toMarkup = (tree: ReactNode) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages: en, children: tree as never }),
  ).replace(/<script[\s\S]*?<\/script>/g, '');

describe('D3 · the Adjustments screen, rendered: the picker and the pointer follow the module', () => {
  it('module OFF — Replacement Leave is offered and no pointer to Leave Credit is drawn (main@60a40452)', async () => {
    const rl = await insertReplacementType();
    ADMIN = await ctxWithToil(false);
    const html = toMarkup(await settle(await AdjustmentsPage({ searchParams: Promise.resolve({}) })));
    expect(recorded.adjustmentFormLeaveTypes).toHaveLength(1);
    const offered = recorded.adjustmentFormLeaveTypes[0].map((o) => o.value);
    expect(offered).toContain(rl);
    expect(offered).toContain(b.annualLeaveTypeId);
    expect(html).not.toContain('data-testid="adjustments-replacement-note"');
    expect(html).not.toContain('href="/admin/leave-config/leave-credit"');
  });

  it('module ON — Replacement Leave leaves the picker and the pointer links to Leave Credit', async () => {
    const rl = await insertReplacementType();
    ADMIN = await ctxWithToil(true);
    const html = toMarkup(await settle(await AdjustmentsPage({ searchParams: Promise.resolve({}) })));
    expect(recorded.adjustmentFormLeaveTypes).toHaveLength(1);
    const offered = recorded.adjustmentFormLeaveTypes[0].map((o) => o.value);
    expect(offered).not.toContain(rl);
    expect(offered).toContain(b.annualLeaveTypeId);
    expect(html).toContain('data-testid="adjustments-replacement-note"');
    expect(html).toMatch(/<a[^>]*href="\/admin\/leave-config\/leave-credit"[^>]*>Leave Credit →<\/a>/);
  });
});

// ─────────────────────────────── D4 · editing into Emergency Leave ───────────────────────────────

describe('D4 · editLeaveRequest refuses Emergency only where requestLeave decomposes it', () => {
  let subjectCtx: SessionContext;
  let subject: { personId: string; employmentId: string };
  const start = () => nextMonday(addDays(TODAY, 21));

  async function emergencyType(balanceSourceTypeId: string | null) {
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: 'EL',
        name: 'Emergency Leave',
        role: 'emergency',
        paid: true,
        counting: 'working_days',
        balanceSourceTypeId,
        // Without a source EL has no balance of its own; the balance gate is opened so that, were the refusal
        // gone, the edit would SUCCEED — the refusal is then the only thing that can stop it.
        allowNegativeBalance: balanceSourceTypeId == null,
      })
      .returning({ id: schema.leaveType.id });
    return row.id;
  }
  async function pendingAnnual() {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: start(),
      endDate: addDays(start(), 2),
    });
    return res.leaveRequestId;
  }

  beforeEach(async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
    subject = await hire('Subject');
    subjectCtx = {
      tenantId: b.tenantId,
      userId: await createAppUser(b.tenantId, subject.personId, 'employee'),
      personId: subject.personId,
      roles: ['employee'],
    };
    const mgr = await hire('Manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: subject.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '20.00',
      effectiveOn: `${TODAY.slice(0, 4)}-01-01`,
    });
  });

  it('NO balance source (the decomposition): refused — the edit would persist a row requestLeave never writes', async () => {
    const el = await emergencyType(null);
    const id = await pendingAnnual();
    await expect(
      editLeaveRequest(subjectCtx, { leaveRequestId: id, leaveTypeId: el, startDate: start(), endDate: addDays(start(), 1) }),
    ).rejects.toBeInstanceOf(LeaveEditNotAllowedError);
    const [row] = await owner.db.select({ leaveTypeId: schema.leaveRequest.leaveTypeId }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id));
    expect(row.leaveTypeId).toBe(b.annualLeaveTypeId);
  });

  it('WITH a balance source (one ordinary request, production’s EL): submitted as one row and editable like any type', async () => {
    const el = await emergencyType(b.annualLeaveTypeId);
    // requestLeave's own verdict first: with a source, EL is saved as ONE request, not decomposed.
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: el,
      startDate: start(),
      endDate: addDays(start(), 2),
    });
    const [saved] = await owner.db
      .select({ leaveTypeId: schema.leaveRequest.leaveTypeId, parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, res.leaveRequestId));
    expect(saved).toEqual({ leaveTypeId: el, parentGroupId: null });
    // …and the edit re-validates it in place.
    const out = await editLeaveRequest(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      leaveTypeId: el,
      startDate: start(),
      endDate: addDays(start(), 1),
    });
    expect(out.days).toBe(2);
    // An ordinary Annual request may also be edited INTO it.
    const annualId = await (async () => {
      const r = await requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: addDays(start(), 7),
        endDate: addDays(start(), 7),
      });
      return r.leaveRequestId;
    })();
    await expect(
      editLeaveRequest(subjectCtx, { leaveRequestId: annualId, leaveTypeId: el, startDate: addDays(start(), 7), endDate: addDays(start(), 7) }),
    ).resolves.toMatchObject({ days: 1 });
  });
});

// ─────────────────────────────── D8 · the Apply form's Expiring soon ───────────────────────────────

describe('D8 · Expiring soon exists only with the module', () => {
  it('module OFF — null for Replacement Leave, so the Apply form draws main’s summary; the other figures are unchanged', async () => {
    const rl = await insertReplacementType();
    const emp = await hire('Applies Off');
    const off = await leaveTypeApplySummary(await ctxWithToil(false), { employmentId: emp.employmentId, leaveTypeId: rl });
    expect(off.expiringSoon).toBeNull();
    const on = await leaveTypeApplySummary(await ctxWithToil(true), { employmentId: emp.employmentId, leaveTypeId: rl });
    expect({ ...off, expiringSoon: 0 }).toEqual(on);
  });

  it('module ON — a number for Replacement Leave (0 with no credits), still null for any other type', async () => {
    const rl = await insertReplacementType();
    const emp = await hire('Applies On');
    const ctx = await ctxWithToil(true);
    expect((await leaveTypeApplySummary(ctx, { employmentId: emp.employmentId, leaveTypeId: rl })).expiringSoon).toBe(0);
    expect((await leaveTypeApplySummary(ctx, { employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId })).expiringSoon).toBeNull();
  });

  it('the form renders the column only for a number, and the action passes the service figure through', () => {
    expect(read('components/leave-duration-fields.tsx')).toContain('{summary.expiringSoon != null && (');
    expect(read('app/leave/actions.ts')).toContain('expiringSoon: view.available ? s.expiringSoon : null,');
  });
});

// ─────────────────────────────── D9 · Leave Balance Health ───────────────────────────────

describe('D9 · Leave Balance Health — the pure derivation, both arms', () => {
  // r300 integration — the Leave Credit replacement of findings must not swallow r299's stranded-method finding.
  it('a replacement-role type on an EARNED method with the module on stays BLOCKED, not Ready', () => {
    const h = leaveTypeConfigHealth({
      leaveType: {
        id: 'lt-rl2', name: 'Replacement Leave', accrualMethod: 'earned_monthly', accrualUnconfigured: false,
        daysFromLeaveCreditOnly: true, defaultEntitlementTemplateLineageId: null, archived: false, earnedMethodNotAnnualLeave: true,
      },
      templates: [], rules: [], grades: [], today: '2026-09-17',
    });
    expect(h.findings).toEqual(['earned_method_not_annual_leave']);
    expect(h.status).toBe('blocked');
  });

  const type = (over: Partial<HealthLeaveType> = {}): HealthLeaveType => ({
    id: 'lt-rl',
    name: 'Replacement Leave',
    accrualMethod: 'full_upfront',
    accrualUnconfigured: false,
    daysFromLeaveCreditOnly: false,
    defaultEntitlementTemplateLineageId: null,
    archived: false,
    // r300 integration — Earned Accrual's flag (r299, main) is required too; false leaves this derivation unchanged.
    earnedMethodNotAnnualLeave: false,
    ...over,
  });
  const table: HealthTemplate = {
    lineageId: 'tpl-rl',
    leaveTypeId: 'lt-rl',
    name: 'RL days',
    validFrom: '2020-01-01',
    validTo: null,
    serviceBands: [{ days: 2 }],
  };
  const stopped: HealthTemplate = { ...table, lineageId: 'tpl-old', name: 'RL old', validTo: '2021-01-01' };
  const health = (t: HealthLeaveType, templates: HealthTemplate[]) =>
    leaveTypeConfigHealth({ leaveType: t, templates, rules: [], grades: [], today: TODAY });

  it('without Leave Credit the findings are exactly as before (no new finding; no table still blocks)', () => {
    expect(health(type(), [table]).findings).toEqual([]);
    expect(health(type(), [table]).leaveCreditTables).toEqual([]);
    expect(health(type(), []).findings).toEqual(['no_entitlement_table']);
    expect(health(type(), []).status).toBe('blocked');
  });

  it('with Leave Credit: a table in force is the ONE finding, naming it (Needs attention); no table reads Ready', () => {
    const withTable = health(type({ daysFromLeaveCreditOnly: true }), [table, stopped]);
    expect(withTable.findings).toEqual(['replacement_leave_has_entitlement_table']);
    expect(withTable.leaveCreditTables).toEqual(['RL days']); // the stopped version is not in force, not named
    expect(withTable.status).toBe('warning');
    const without = health(type({ daysFromLeaveCreditOnly: true }), [stopped]);
    expect(without.findings).toEqual([]);
    expect(without.status).toBe('ready');
  });

  it('the loader decides the flag from the module AND the role, and the sentence exists in six locales', () => {
    const loader = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(loader).toContain("const leaveCreditLive = isModuleEnabledOrFalse(s, 'toil');");
    expect(loader).toContain("daysFromLeaveCreditOnly: leaveCreditLive && leaveTypeIs(x, 'replacement'),");
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const v = JSON.parse(read(`messages/${loc}.json`)).admin.entitlementTemplates.healthReplacementLeaveHasEntitlementTable;
      expect(typeof v === 'string' && v.includes('{tables}'), loc).toBe(true);
    }
  });
});

describe('D9 · Leave Balance Health, rendered', () => {
  const SENTENCE_START = 'Leave Credit is switched on, so every day of this leave type should come from Leave Credit.';
  const rowOf = (html: string, name: string) => {
    const at = html.indexOf(`<td class="px-3 py-2 font-medium">${name}</td>`);
    expect(at, `${name} has a row`).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf('</tr>', at));
  };
  const render = async () => toMarkup(await settle(await BalanceHealthPage()));
  const tableOn = (rl: string) =>
    createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: rl,
      name: 'Replacement days table',
      serviceBands: [{ fromYears: 0, toYears: null, days: 2 }],
      validFrom: `${TODAY.slice(0, 4)}-01-01`,
    });

  it('module OFF — a Replacement Leave table raises nothing new, and no table still reads as before (main)', async () => {
    const rl = await insertReplacementType();
    ADMIN = await ctxWithToil(false);
    expect(rowOf(await render(), 'Replacement Leave')).toContain(en.admin.entitlementTemplates.healthNoEntitlementTable);
    await tableOn(rl);
    const row = rowOf(await render(), 'Replacement Leave');
    expect(row).not.toContain(SENTENCE_START);
    expect(row).toContain(en.admin.entitlementTemplates.healthNothingMissing);
  });

  it('module ON — the table in force is named and the type needs attention; with no table it reads Ready', async () => {
    const rl = await insertReplacementType();
    ADMIN = await ctxWithToil(true);
    const bare = rowOf(await render(), 'Replacement Leave');
    expect(bare).not.toContain(en.admin.entitlementTemplates.healthNoEntitlementTable);
    expect(bare).toContain(en.admin.entitlementTemplates.healthStatusReady);
    await tableOn(rl);
    const row = rowOf(await render(), 'Replacement Leave');
    expect(row).toContain(`${SENTENCE_START} An entitlement table in force still adds days nobody earned: Replacement days table. Remove the table.`);
    expect(row).toContain(en.admin.entitlementTemplates.healthStatusWarning);
    // Annual Leave on the same tenant is judged as it always was (it has no table: still "no entitlement table").
    const annual = rowOf(await render(), 'Annual Leave');
    expect(annual).not.toContain(SENTENCE_START);
    expect(annual).toContain(en.admin.entitlementTemplates.healthNoEntitlementTable);
  });
});
