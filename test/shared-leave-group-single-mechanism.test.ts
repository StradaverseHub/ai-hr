/**
 * ONE mechanism for sharing across leave types (r77, feedback 1ef1cf95 — HELD).
 *
 * 1ef1cf95 asked for a "Shared Leave Group" on the Leave Type screen: several leave types under one
 * configuration. Investigating it found the sharing mechanism ALREADY SHIPPED, twice reworked and
 * already surfaced on that very screen:
 *
 *   - `scheme_leave_combined_limit` + `_member` (migration 0220, feedback 4c48fd1f) — a NAMED group of
 *     leave types with one shared day total, per benefit scheme. Config CRUD in core/benefit-scheme.ts,
 *     enforcement in core/leave.ts (`enforceCombinedLeaveLimit`, called on submit and on approval).
 *   - d6f88c2f turned creation into drag-to-group with a name + shared-total confirm dialog.
 *   - 6c775d68 moved that whole area INSIDE each leave type's Entitlement step, scoped to the type, with
 *     a "shared with <other types>" badge on groups spanning other types and a per-row "Shared limit
 *     <name>: <days> days/year" line.
 *
 * The part of 1ef1cf95 that is genuinely unbuilt — a group that OWNS entitlement configuration, so its
 * member types stop having their own — was held: it needs new tables and it would put a SECOND thing in
 * front of `entitledDays`, on a different axis (tenant-wide) from the existing per-scheme one. Two
 * mechanisms that both decide leave across a set of types will disagree, and the disagreement is about
 * how many days somebody gets.
 *
 * This is the ratchet for that decision. It does not forbid building the group — it forbids building it
 * SILENTLY. Whoever implements it must come here, read this, and change these assertions deliberately.
 *
 * Static source guard (repo convention for this area — see benefit-scheme-scoped-step.test.ts). Behaviour
 * of the existing mechanism is covered by test/combined-leave-limit.test.ts; nothing here re-tests it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

const schemaSrc = read('../db/schema.ts');
const computeSrc = read('../core/leave-compute.ts');
const schemeConfigSrc = read('../components/benefit-scheme-config.tsx');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The two tables that ARE the shared-leave-group mechanism. */
const SHARING_TABLES = ['scheme_leave_combined_limit', 'scheme_leave_combined_limit_member'] as const;

describe('1ef1cf95 · exactly one table pair groups leave types for sharing', () => {
  it('db/schema.ts declares no second leave-type grouping mechanism', () => {
    // Every pgTable name in the schema whose NAME claims to group/pool leave types. `grade_group*` and
    // `holiday_group*` group grades and holidays, not leave types, so they are outside this net by name.
    const names = [...schemaSrc.matchAll(/pgTable\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const sharing = names.filter((n) => /combined_limit|leave_group|leave_type_group|shared_leave/.test(n));
    expect(sharing.sort()).toEqual([...SHARING_TABLES].sort());
  });

  it('the member table pins a leave type to at most one group per scheme', () => {
    // The uniqueness that makes "which group owns this type" answerable at all. Losing it is how two
    // groups start disagreeing about the same type.
    expect(schemaSrc).toContain(
      "uniqueIndex('scheme_leave_combined_limit_member_uq').on(t.tenantId, t.benefitSchemeId, t.leaveTypeId)",
    );
  });

  it('only the leave engine and its benefit-scheme config module touch those tables', () => {
    const coreFiles = readdirSync(resolve(here, '../core')).filter((f) => f.endsWith('.ts'));
    const touching = coreFiles.filter((f) => read(`../core/${f}`).includes('schemeLeaveCombinedLimit'));
    expect(touching.sort()).toEqual(['benefit-scheme.ts', 'leave.ts']);
  });
});

describe('1ef1cf95 · sharing caps what is TAKEN, never what is GRANTED', () => {
  it('the entitlement kernel does not consult the shared-group tables', () => {
    // core/leave-compute.ts is the whole of the entitlement arithmetic. A shared group that fed days into
    // it would be a second entitlement source beside benefit scheme and leave policy.
    expect(computeSrc).not.toMatch(/combinedLimit|combined_limit/i);
  });

  it('entitledDays still resolves from exactly three inputs', () => {
    // floor (statutory pack) vs scheme days vs policy days — schemeDays null, not zero, is the fallback
    // trigger. A group day-source would appear here as a fourth input.
    expect(computeSrc).toContain('return Math.max(floorDays, schemeDays ?? policyDays);');
    expect(computeSrc).toMatch(
      /export function entitledDays\(\s*floorDays: number,\s*schemeDays: number \| null,\s*policyDays: number,\s*\): number/,
    );
  });

  it('the group carries usage caps and no entitlement bands', () => {
    // scheme_leave_combined_limit holds name + total_limit_days + (r82a, migration 0327) the
    // per-application cap max_days_per_application. Both are limits on what may be TAKEN. Service bands
    // (the day figures) live on scheme_leave_entitlement / leave_policy, per leave type — the group never
    // restates them.
    const block = schemaSrc.slice(
      schemaSrc.indexOf("export const schemeLeaveCombinedLimit = pgTable"),
      schemaSrc.indexOf("export const schemeLeaveCombinedLimitMember = pgTable"),
    );
    expect(block).toContain("numeric('total_limit_days'");
    expect(block).not.toMatch(/service_bands|annual_days|accrual|carry_forward/);
  });

  it('the per-application cap lives on THAT group, not on a mechanism of its own (r82a 1ef1cf95)', () => {
    // 1ef1cf95's second rule — "each application is capped at N consecutive days regardless of which type
    // is chosen" — is a statement about the SAME set of leave types the shared pool already names. Putting
    // it anywhere else (a new table, a per-leave-type column, a tenant-wide setting) recreates exactly the
    // disagreement this file exists to prevent: two places that both decide how much leave one application
    // may take. The table-name assertion above already forbids a second table; this pins the column to the
    // group and forbids a rival per-type column on leave_type.
    const block = schemaSrc.slice(
      schemaSrc.indexOf("export const schemeLeaveCombinedLimit = pgTable"),
      schemaSrc.indexOf("export const schemeLeaveCombinedLimitMember = pgTable"),
    );
    expect(block).toContain("numeric('max_days_per_application'");
    const leaveTypeBlock = schemaSrc.slice(
      schemaSrc.indexOf("export const leaveType = pgTable"),
      schemaSrc.indexOf("export const leavePolicy = pgTable"),
    );
    expect(leaveTypeBlock).not.toMatch(/max_days_per_application|max_consecutive|per_request_limit/);
  });
});

describe('1ef1cf95 · group membership is already visible on the Leave Type screen', () => {
  it('a scoped Entitlement step names the other types sharing the cap', () => {
    // 6c775d68's badge. Without it, editing a shared total from one type silently moves another type.
    expect(schemeConfigSrc).toContain("t('sharedWithTypes'");
    expect(schemeConfigSrc).toContain("t('perTypeSharedPool'");
  });

  it('a group can be created from a LABELLED control, not only by discovering the drag (r82a 1ef1cf95)', () => {
    // The reporter reported this feature as missing because the only way to reach it was to drag one row
    // onto another, with nothing on screen saying so. The button is the fix — and it must open the SAME
    // dialog and post the SAME action as the drag, so exactly one CreateGroupDialog may be declared and
    // exactly one component may post groupLeaveTypes. A second creation path is a second mechanism.
    expect(schemeConfigSrc).toContain("t('createGroupButton')");
    expect(schemeConfigSrc.match(/function CreateGroupDialog\(/g) ?? []).toHaveLength(1);
    expect(schemeConfigSrc.match(/<CreateGroupDialog\b/g) ?? []).toHaveLength(1);
    expect(schemeConfigSrc.match(/action=\{actions\.groupLeaveTypes\}/g) ?? []).toHaveLength(1);
  });

  it('every locale carries the three shared-group strings', () => {
    // tsc cannot see a missing translation key; six locales, no guard.
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`../messages/${loc}.json`));
      expect(m.admin.benefitScheme.sharedWithTypes, `${loc} sharedWithTypes`).toBeTruthy();
      expect(m.admin.benefitScheme.perTypeSharedPool, `${loc} perTypeSharedPool`).toBeTruthy();
      expect(m.leave.errors.combinedLimitExceeded, `${loc} combinedLimitExceeded`).toBeTruthy();
      // r82a 1ef1cf95 — the affordance + the per-application cap. The i18n guard skips multi-namespace
      // files and only matches literal t('key'), so these six locales are not covered anywhere else.
      expect(m.admin.benefitScheme.createGroupButton, `${loc} createGroupButton`).toBeTruthy();
      expect(m.admin.benefitScheme.maxDaysPerApplication, `${loc} maxDaysPerApplication`).toBeTruthy();
      expect(m.leave.errors.combinedApplicationTooLong, `${loc} combinedApplicationTooLong`).toBeTruthy();
    }
  });
});
