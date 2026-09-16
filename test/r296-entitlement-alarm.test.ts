/**
 * r296 / readiness 2.1 — THE ENTITLEMENT ENGINE GOING DARK MUST RAISE AN ALARM, AND A HEALTHY TENANT
 * MUST NOT.
 *
 * On 2026-09-12 a live tenant held ZERO entitlement templates and ZERO eligibility rules in force,
 * nobody resolved to any leave entitlement, it stayed that way for a day, and nothing raised an alarm.
 *
 * ── WHAT THIS FILE IS GUARDING, AND IT IS NOT "the alarm fires" ────────────────────────────────────
 * A test that only proves the alarm fires passes identically against code that alarms on EVERYTHING —
 * which is the worse defect, because a channel that cries wolf is muted and then the real alarm is
 * gone too. So every alarm case here is paired with its negative IN THE SAME SWEEP, over the same
 * database, so the assertion is the DIFFERENCE between two tenants and not the presence of a finding:
 *
 *   • a tenant whose tables went to zero ALARMS ── and a healthy tenant beside it does NOT
 *   • a leave type whose tables reach nobody ALARMS ── and a type whose rule reaches somebody does NOT
 *
 * And the two states that make the alarm usable rather than merely correct, each pinned on its own:
 *
 *   • a DELIBERATELY RETIRED rule does not alarm — the reporter retired rule e1aa6e06 on purpose that
 *     same evening while 1 template and 1 rule stayed in force. Alarming on a retirement would have
 *     fired on the fix.
 *   • a BRAND-NEW tenant does not alarm — it legitimately has zero of everything, and an alarm that
 *     fires on every freshly provisioned customer is an alarm nobody reads.
 *
 * ── AND THE THING THAT MUST NOT BE TRUE OF A DETECTOR ─────────────────────────────────────────────
 * It must not be able to change what it is watching. The read-only case at the bottom reaches INSIDE
 * the module's own transaction (through the one collaborator it calls with the live `tx`) and proves
 * Postgres refuses a write there — not that a comment says so.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createEligibilityRule, createEntitlementTemplate, retireEligibilityRule, retireEntitlementTemplate } from '../core/entitlement-template';
import {
  ALARM_EXIT,
  alarmExitCode,
  checkTenantEntitlementHealth,
  engineIsDark,
  entitlementAlarmSweep,
  quietReasonFor,
  type EntitlementAlarmRun,
} from '../core/entitlement-alarm';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/**
 * The read-only probe. Hoisted so `vi.mock` below can close over it, and OFF by default so every other
 * case in this file runs against the real collaborator.
 *
 * `resolveOrgCriteriaTargets` is the one function `checkTenantEntitlementHealth` hands its live `tx` to,
 * which makes it the seam that can observe the transaction from the inside. The write attempt runs in a
 * NESTED transaction — a SAVEPOINT — so a refusal rolls back to the savepoint instead of poisoning the
 * outer transaction and turning the read-only proof into a crash that would pass for one.
 */
const probe = vi.hoisted(() => ({
  enabled: false,
  attempts: 0,
  refusal: null as string | null,
  wrote: false,
}));

vi.mock('../core/org-criteria', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/org-criteria')>();
  return {
    ...actual,
    resolveOrgCriteriaTargets: async (tx: Parameters<typeof actual.resolveOrgCriteriaTargets>[0], p: Parameters<typeof actual.resolveOrgCriteriaTargets>[1]) => {
      if (probe.enabled) {
        probe.attempts += 1;
        try {
          await tx.transaction(async (inner) => {
            await inner.execute(sql`create table r296_probe_${sql.raw(String(probe.attempts))} (a int)`);
          });
          probe.wrote = true;
        } catch (e) {
          // drizzle wraps the driver error as "Failed query: ..." and hangs the Postgres error off
          // `cause`. The REASON is the whole point of this probe — a write refused for some unrelated
          // reason (a missing grant, a broken transaction) would prove nothing — so both are recorded.
          const err = e as Error & { cause?: Error };
          probe.refusal = `${err?.message ?? e} | cause: ${err?.cause?.message ?? '(none)'}`;
        }
      }
      return actual.resolveOrgCriteriaTargets(tx, p);
    },
  };
});

const TODAY = todayInKualaLumpur();
/** A date `n` days from TODAY, derived from the clock — never a hardcoded future date. */
function day(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let a: Base;
let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  probe.enabled = false;
  probe.attempts = 0;
  probe.refusal = null;
  probe.wrote = false;
  await resetDb();
  a = await seedBase();
  b = await seedBase();
});
afterAll(closeAll);

/** A leave type whose code is not a standing statutory code, so the table is its only source of days. */
async function customType(base: Base, code: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: base.tenantId, code, name: `${code} Leave`, paid: true })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function grade(base: Base, code: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: base.tenantId, code, name: code })
    .returning({ id: schema.jobGrade.id });
  return row.id;
}

function hire(base: Base) {
  return hireEmployee(adminCtx(base), {
    person: { fullName: 'R296', primaryEmail: `r296_${randomUUID().slice(0, 8)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: day(-400),
  });
}

/** A named table for a type, plus an eligibility rule. `criteria` defaults to "everyone". */
async function configure(
  base: Base,
  p: { leaveTypeId: string; validFrom?: string; criteria?: Record<string, unknown>; withRule?: boolean },
) {
  const validFrom = p.validFrom ?? day(-30);
  const tpl = await createEntitlementTemplate(adminCtx(base), {
    leaveTypeId: p.leaveTypeId,
    name: `Table ${randomUUID().slice(0, 6)}`,
    serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
    validFrom,
  });
  let ruleLineageId: string | null = null;
  if (p.withRule !== false) {
    const rule = await createEligibilityRule(adminCtx(base), {
      name: `${tpl.name} — eligibility`,
      templateLineageId: tpl.lineageId,
      criteria: (p.criteria ?? {}) as never,
      validFrom,
    });
    ruleLineageId = rule.lineageId;
  }
  return { templateLineageId: tpl.lineageId, ruleLineageId };
}

const sweep = (): Promise<EntitlementAlarmRun> => entitlementAlarmSweep(owner.db, { asOf: TODAY });
const healthOf = (run: EntitlementAlarmRun, base: Base) =>
  run.health.find((h) => h.tenantId === base.tenantId)!;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('r296 · the predicate, without a database', () => {
  it('engineIsDark needs ALL THREE terms — nothing in force, something that HAD started, somebody to hurt', () => {
    // The outage: configured, and now zero.
    expect(engineIsDark({ templatesInForce: 0, templatesStarted: 2, activeEmployments: 5 })).toBe(true);
    // A brand-new tenant: nothing ever started. This is the term that stops the alarm firing on every
    // freshly provisioned customer.
    expect(engineIsDark({ templatesInForce: 0, templatesStarted: 0, activeEmployments: 5 })).toBe(false);
    // Healthy: something is in force. Without this term the alarm would fire on every tenant.
    expect(engineIsDark({ templatesInForce: 1, templatesStarted: 2, activeEmployments: 5 })).toBe(false);
    // Nobody employed: there is no one who can be refused leave.
    expect(engineIsDark({ templatesInForce: 0, templatesStarted: 2, activeEmployments: 0 })).toBe(false);
  });

  it('quietReasonFor names WHY a silent tenant was silent, and says nothing about a healthy one', () => {
    expect(quietReasonFor({ templatesInForce: 0, templatesStarted: 0, templatesEver: 0, activeEmployments: 3 })).toBe(
      'never_configured',
    );
    // Rows exist, but every one of them starts in the future — a tenant mid-setup, not a tenant that lost
    // its configuration.
    expect(quietReasonFor({ templatesInForce: 0, templatesStarted: 0, templatesEver: 4, activeEmployments: 3 })).toBe(
      'not_started_yet',
    );
    expect(quietReasonFor({ templatesInForce: 0, templatesStarted: 2, templatesEver: 2, activeEmployments: 0 })).toBe(
      'no_active_employments',
    );
    // Healthy and dark both have nothing to explain, for opposite reasons.
    expect(quietReasonFor({ templatesInForce: 1, templatesStarted: 1, templatesEver: 1, activeEmployments: 3 })).toBeNull();
    expect(quietReasonFor({ templatesInForce: 0, templatesStarted: 2, templatesEver: 2, activeEmployments: 3 })).toBeNull();
  });

  it('alarmExitCode: clean 0, alarm 3, and a tenant that could not be checked OUTRANKS a finding', () => {
    expect(alarmExitCode({ tenantsFailed: 0, alarms: 0 })).toBe(ALARM_EXIT.CLEAN);
    expect(alarmExitCode({ tenantsFailed: 0, alarms: 1 })).toBe(ALARM_EXIT.ALARM);
    expect(alarmExitCode({ tenantsFailed: 1, alarms: 0 })).toBe(ALARM_EXIT.INDETERMINATE);
    // A hole in the answer is not softened by the findings it did manage to make.
    expect(alarmExitCode({ tenantsFailed: 1, alarms: 4 })).toBe(ALARM_EXIT.INDETERMINATE);
    // Every alarm state is non-zero, which is the only thing deploy/cron-alert.sh reads.
    expect(ALARM_EXIT.ALARM).not.toBe(0);
    expect(ALARM_EXIT.INDETERMINATE).not.toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('r296 · alarm 1 — a tenant whose entitlement tables in force dropped to zero', () => {
  it('the zeroed tenant ALARMS and the healthy tenant in the same sweep does NOT', async () => {
    const typeA = await customType(a, 'CUSTOM_A');
    const typeB = await customType(b, 'CUSTOM_B');
    await hire(a);
    await hire(b);
    const cfgA = await configure(a, { leaveTypeId: typeA });
    await configure(b, { leaveTypeId: typeB });

    // THE ADMIN EDIT. One retirement, and tenant A's last table stops being in force today.
    await retireEntitlementTemplate(adminCtx(a), { lineageId: cfgA.templateLineageId, validTo: TODAY });

    const run = await sweep();

    // ARM ONE — the zeroed tenant is found.
    const ha = healthOf(run, a);
    expect(ha.templatesInForce).toBe(0);
    expect(ha.templatesStarted).toBe(1);
    expect(ha.alarms.map((x) => x.kind)).toEqual(['engine_dark']);
    expect(ha.lastStoppedOn).toBe(TODAY);
    expect(ha.quiet).toBeNull();

    // ARM TWO — AND THIS IS THE ONE A VACUOUS GUARD WOULD MISS. The healthy tenant, in the same run
    // over the same database, is silent. Code that alarmed on everything would pass arm one alone.
    const hb = healthOf(run, b);
    expect(hb.templatesInForce).toBe(1);
    expect(hb.alarms).toEqual([]);

    // And the sweep says so at the top level: exactly one tenant of the two.
    expect(run.tenantsChecked).toBe(2);
    expect(run.tenantsFailed).toBe(0);
    expect(run.tenantsAlarming).toBe(1);
    expect(run.alarms).toBe(1);
    expect(alarmExitCode(run)).toBe(ALARM_EXIT.ALARM);
  });

  it('the finding is attributed to the tenant that has it, and names no other tenant', async () => {
    const typeA = await customType(a, 'CUSTOM_A');
    const typeB = await customType(b, 'CUSTOM_B');
    await hire(a);
    await hire(b);
    const cfgA = await configure(a, { leaveTypeId: typeA });
    await configure(b, { leaveTypeId: typeB });
    await retireEntitlementTemplate(adminCtx(a), { lineageId: cfgA.templateLineageId, validTo: TODAY });

    const run = await sweep();
    const alarming = run.health.filter((h) => h.alarms.length > 0);
    expect(alarming).toHaveLength(1);
    expect(alarming[0].tenantId).toBe(a.tenantId);
    // Tenant A's counts are A's only: B's one live table must not be counted into A's, which is exactly
    // what would happen if the reads leaned on RLS under an owner connection instead of scoping
    // themselves. The sweep runs on the app pool AND filters by tenant_id; this is the observable.
    expect(alarming[0].templatesEver).toBe(1);
    expect(healthOf(run, b).templatesEver).toBe(1);
  });

  it('a zeroed tenant with nobody employed stays silent — there is no one to be refused leave', async () => {
    const typeA = await customType(a, 'CUSTOM_A');
    const cfgA = await configure(a, { leaveTypeId: typeA });
    await retireEntitlementTemplate(adminCtx(a), { lineageId: cfgA.templateLineageId, validTo: TODAY });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    expect(h.templatesInForce).toBe(0);
    expect(h.templatesStarted).toBe(1);
    expect(h.activeEmployments).toBe(0);
    expect(h.alarms).toEqual([]);
    expect(h.quiet).toBe('no_active_employments');
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('r296 · a DELIBERATELY RETIRED rule must not alarm', () => {
  it('retiring one rule while another table and rule stay in force raises nothing — the 2026-09-12 evening state', async () => {
    const t1 = await customType(a, 'CUSTOM_1');
    const t2 = await customType(a, 'CUSTOM_2');
    await hire(a);
    const keep = await configure(a, { leaveTypeId: t1 });
    const retire = await configure(a, { leaveTypeId: t2 });

    // The reporter's own act: a rule stopped ON PURPOSE. Its table goes with it, and the OTHER leave
    // type's table and rule are untouched — which is the state measured on 2026-09-13 (1 template and
    // 1 rule in force) and is healthy.
    await retireEligibilityRule(adminCtx(a), { lineageId: retire.ruleLineageId!, validTo: TODAY });
    await retireEntitlementTemplate(adminCtx(a), { lineageId: retire.templateLineageId, validTo: TODAY });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    expect(h.templatesInForce).toBe(1);
    expect(h.rulesInForce).toBe(1);
    expect(h.alarms).toEqual([]);
    expect(keep.ruleLineageId).not.toBeNull();
  });

  it('retiring the only RULE while its table stays in force is silent — the sole table then reaches everyone', async () => {
    const t1 = await customType(a, 'CUSTOM_1');
    await hire(a);
    const cfg = await configure(a, { leaveTypeId: t1 });

    // r193 fault 3: one table in force and NO rule in force ⇒ that table is the answer for everybody.
    // Alarming on "rules in force dropped to zero" would fire here, on a configuration the engine
    // resolves perfectly well. This is why the predicate never counts rules.
    await retireEligibilityRule(adminCtx(a), { lineageId: cfg.ruleLineageId!, validTo: TODAY });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    expect(h.rulesInForce).toBe(0);
    expect(h.templatesInForce).toBe(1);
    expect(h.alarms).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('r296 · a BRAND-NEW tenant must not alarm', () => {
  it('a tenant with employees and no entitlement configuration at all is silent, and says why', async () => {
    await hire(a);
    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    expect(h.activeEmployments).toBe(1);
    expect(h.templatesEver).toBe(0);
    expect(h.alarms).toEqual([]);
    expect(h.quiet).toBe('never_configured');
  });

  it('a tenant in the middle of setup, whose only tables start next month, is silent', async () => {
    const t1 = await customType(a, 'CUSTOM_1');
    await hire(a);
    await configure(a, { leaveTypeId: t1, validFrom: day(30) });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    // Rows exist — so "has this tenant ever been configured" read as row-count alone would alarm here.
    expect(h.templatesEver).toBe(1);
    expect(h.templatesStarted).toBe(0);
    expect(h.templatesInForce).toBe(0);
    expect(h.alarms).toEqual([]);
    expect(h.quiet).toBe('not_started_yet');
  });

  it('a completely empty tenant raises nothing, and a swept pair of them exits 0', async () => {
    const run = await sweep();
    expect(run.tenantsChecked).toBe(2);
    expect(run.alarms).toBe(0);
    expect(alarmExitCode(run)).toBe(ALARM_EXIT.CLEAN);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('r296 · alarm 2 — a leave type that resolves for nobody', () => {
  it('a type whose tables reach nobody ALARMS, and a type whose rule reaches somebody does NOT', async () => {
    const unreachable = await customType(a, 'UNREACHABLE');
    const reachable = await customType(a, 'REACHABLE');
    await hire(a); // no job grade recorded

    // Tables in force for both. One rule narrows to a grade this employee does not hold; the other
    // narrows by nothing, which core/org-criteria.ts documents as "everyone".
    const nobodysGrade = await grade(a, 'G99');
    await configure(a, { leaveTypeId: unreachable, criteria: { gradeIds: [nobodysGrade] } });
    await configure(a, { leaveTypeId: reachable });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);

    // ARM ONE — the half-built type is named.
    expect(h.alarms.map((x) => x.kind)).toEqual(['type_resolves_for_nobody']);
    expect(h.alarms[0].leaveTypeCode).toBe('UNREACHABLE');

    // ARM TWO — the type that DOES reach somebody is not in the findings, in the same tenant, in the
    // same pass. Without this, code that flagged every leave type would pass arm one.
    expect(h.alarms.map((x) => x.leaveTypeCode)).not.toContain('REACHABLE');
    // Both types have a table in force; only one of them is a finding.
    expect(h.leaveTypesWithTemplateInForce).toBe(2);
    // The tenant is NOT dark — tables are in force. The two alarms are genuinely different questions.
    expect(h.templatesInForce).toBe(2);
    expect(h.alarms.some((x) => x.kind === 'engine_dark')).toBe(false);
  });

  it('a leave type with NO table at all is not a finding — nobody was ever meant to get days there', async () => {
    const reachable = await customType(a, 'REACHABLE');
    await hire(a);
    await configure(a, { leaveTypeId: reachable });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    // seedBase's ANNUAL type is active and carries no entitlement table. It must not be reported: this
    // is core/entitlement-scheme-view.ts's shipped position, and the reporting tenant had 1 table across
    // nine active types — flagging the other eight would have buried the one real finding on night one.
    expect(h.leaveTypesActive).toBeGreaterThan(h.leaveTypesWithTemplateInForce);
    expect(h.alarms).toEqual([]);
  });

  it('a dark tenant raises the engine alarm ONCE, not one finding per leave type', async () => {
    const t1 = await customType(a, 'CUSTOM_1');
    const t2 = await customType(a, 'CUSTOM_2');
    await hire(a);
    const c1 = await configure(a, { leaveTypeId: t1 });
    const c2 = await configure(a, { leaveTypeId: t2 });
    await retireEntitlementTemplate(adminCtx(a), { lineageId: c1.templateLineageId, validTo: TODAY });
    await retireEntitlementTemplate(adminCtx(a), { lineageId: c2.templateLineageId, validTo: TODAY });

    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);
    expect(h.alarms.map((x) => x.kind)).toEqual(['engine_dark']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('r296 · the detector cannot change what it is watching', () => {
  it('runs in a READ ONLY transaction — Postgres refuses a write issued from inside it', async () => {
    const t1 = await customType(a, 'CUSTOM_1');
    await hire(a);
    await configure(a, { leaveTypeId: t1 });

    probe.enabled = true;
    const h = await checkTenantEntitlementHealth({ tenantId: a.tenantId, roles: ['hr_admin'] }, TODAY);

    // The probe really ran inside the module's transaction — otherwise the refusal below proves nothing.
    expect(probe.attempts).toBeGreaterThan(0);
    expect(probe.wrote).toBe(false);
    // Refused BY POSTGRES, for being read-only — not by a missing grant and not by an already-broken
    // transaction. The exact string is `cannot execute CREATE TABLE in a read-only transaction`.
    expect(probe.refusal).toContain('cannot execute CREATE TABLE in a read-only transaction');
    // And the check still produced its answer: refusing the write did not break the read.
    expect(h.templatesInForce).toBe(1);
  });

  it('leaves the entitlement tables and the event log byte-identical', async () => {
    const t1 = await customType(a, 'CUSTOM_1');
    await hire(a);
    await configure(a, { leaveTypeId: t1 });

    const snapshot = async () => {
      const rows = await owner.db.execute(sql`
        select
          (select count(*) from entitlement_template) as templates,
          (select count(*) from entitlement_eligibility_rule) as rules,
          (select count(*) from leave_ledger) as ledger,
          (select count(*) from domain_event) as events,
          (select coalesce(md5(string_agg(id::text || coalesce(valid_to::text,'-'), ',' order by id)), '')
             from entitlement_template) as template_digest`);
      return JSON.stringify(rows);
    };
    const before = await snapshot();
    await entitlementAlarmSweep(owner.db, { asOf: TODAY });
    expect(await snapshot()).toBe(before);
  });
});
