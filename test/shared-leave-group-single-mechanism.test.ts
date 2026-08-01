/**
 * ONE mechanism for sharing across leave types (r77, feedback 1ef1cf95 — REBUILT AT LEAVE-TYPE LEVEL in r88).
 *
 * WHAT THIS FILE HAS ALWAYS PROTECTED, and still does: there is exactly ONE way to make several leave types
 * share an allowance, and it caps what may be TAKEN — never what is GRANTED. Two mechanisms that both decide
 * leave across a set of types will disagree, and the disagreement is about how many days somebody gets.
 *
 * WHAT CHANGED IN r88, deliberately, which is what r77 asked of whoever implemented this. r77 held the item
 * and wrote: "It does not forbid building the group — it forbids building it SILENTLY. Whoever implements it
 * must come here, read this, and change these assertions deliberately." This is that change, made in the
 * open:
 *
 *   - The mechanism WAS `scheme_leave_combined_limit` + `_member` (migration 0220, feedback 4c48fd1f), a
 *     named group hung off a BENEFIT SCHEME. r82a added a per-application cap to it; d6f88c2f made creation
 *     a drag; 6c775d68 moved that area inside each leave type's Entitlement step.
 *   - The reporter rejected that shape outright — "I don't want to improve the existing Benefit Scheme
 *     selector" — and asked for the group to be defined once, at LEAVE TYPE level. r88 replaced the pair
 *     with `leave_shared_group` + `leave_shared_group_member` (migration 0339): tenant-level, leave-type
 *     members, no scheme dimension. Config CRUD moved to core/leave-shared-group.ts; enforcement stayed
 *     exactly where it was, in core/leave.ts, at BOTH apply and approval.
 *
 * The count did not go up. It is still ONE table pair, ONE config module, ONE enforcement helper — that is
 * the invariant, and re-pointing the names is not the same act as relaxing it. The assertions below are
 * therefore the SAME assertions against the SAME properties, aimed at the tables that now hold them.
 *
 * Static source guard (repo convention for this area — see benefit-scheme-scoped-step.test.ts). Behaviour
 * of the mechanism is covered by test/combined-leave-limit.test.ts; nothing here re-tests it.
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
const groupConfigSrc = read('../components/leave-shared-group-config.tsx');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The two tables that ARE the shared-leave-group mechanism (r88: renamed from scheme_leave_combined_limit
 *  / _member when the benefit-scheme dimension was dropped — same pair, honest names). */
const SHARING_TABLES = ['leave_shared_group', 'leave_shared_group_member'] as const;

describe('1ef1cf95 · exactly one table pair groups leave types for sharing', () => {
  it('db/schema.ts declares no second leave-type grouping mechanism', () => {
    // Every pgTable name in the schema whose NAME claims to group/pool leave types. `grade_group*` and
    // `holiday_group*` group grades and holidays, not leave types, so they are outside this net by name.
    // `leave_shared_group_reset_archive` is excluded BY NAME below, not by loosening the pattern: it is a
    // dead record of what 0339 removed, never joined to and never read by the engine, so counting it as a
    // rival mechanism would be wrong — but a table that could ever be MISTAKEN for one must be named here
    // rather than quietly slipping through a widened regex.
    const names = [...schemaSrc.matchAll(/pgTable\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const sharing = names
      .filter((n) => /combined_limit|leave_group|leave_type_group|shared_group|shared_leave/.test(n))
      .filter((n) => n !== 'leave_shared_group_reset_archive');
    expect(sharing.sort()).toEqual([...SHARING_TABLES].sort());
  });

  it('the archive is a record, not a mechanism', () => {
    // The one thing that would make the exclusion above a loophole: the archive growing enforceable columns
    // or being read by the engine. It is text-only and write-once (0339).
    const coreFiles = readdirSync(resolve(here, '../core')).filter((f) => f.endsWith('.ts'));
    const readers = coreFiles.filter((f) => read(`../core/${f}`).includes('leaveSharedGroupResetArchive'));
    expect(readers).toEqual([]);
  });

  it('the member table pins a leave type to at most ONE group, tenant-wide', () => {
    // The uniqueness that makes "which group owns this type" answerable at all. Losing it is how two groups
    // start disagreeing about the same type. r88 TIGHTENED this: the key was (tenant, scheme, leave_type),
    // so one type could sit in a different group per scheme; it is now (tenant, leave_type) — one type, one
    // group, everywhere. Re-pointing must never quietly restore the scheme dimension.
    expect(schemaSrc).toContain(
      "uniqueIndex('leave_shared_group_member_uq').on(t.tenantId, t.leaveTypeId)",
    );
    const memberBlock = schemaSrc.slice(schemaSrc.indexOf('export const leaveSharedGroupMember = pgTable'));
    expect(memberBlock.slice(0, memberBlock.indexOf('export const leaveLedger'))).not.toMatch(
      /benefit_scheme_id|benefitSchemeId/,
    );
  });

  it('only the leave engine and its own config module touch those tables', () => {
    // Was ['benefit-scheme.ts', 'leave.ts'] — the config half moved OUT of benefit-scheme.ts into a module
    // of its own when the group stopped being a property of a scheme. Still exactly two files: one that
    // configures, one that enforces.
    const coreFiles = readdirSync(resolve(here, '../core')).filter((f) => f.endsWith('.ts'));
    const touching = coreFiles.filter((f) => read(`../core/${f}`).includes('leaveSharedGroupMember'));
    expect(touching.sort()).toEqual(['leave-shared-group.ts', 'leave.ts']);
  });

  it('the retired scheme-level pair is gone from the schema, not merely unused', () => {
    // A leftover declaration is a second mechanism waiting to be re-wired. 0339 drops the tables; the
    // schema must not still describe them.
    expect(schemaSrc).not.toMatch(/pgTable\(\s*'scheme_leave_combined_limit/);
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
    // COMMENTS STRIPPED FIRST. This guard forbids a rival COLUMN, and it was matching prose: r86a added
    // leave_type.max_days_per_leave_year (a per-YEAR total, a different rule) and correctly cited this
    // very table's max_days_per_application as the naming precedent in a comment. Grepping raw source
    // turned a citation of the invariant into a violation of it. The column names are what matter.
    const leaveTypeBlock = schemaSrc
      .slice(schemaSrc.indexOf("export const leaveType = pgTable"), schemaSrc.indexOf("export const leavePolicy = pgTable"))
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
      .join('\n');
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
