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
 *     with `leave_shared_group` + `leave_shared_group_member` (migration 0342): tenant-level, leave-type
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
    // dead record of what 0342 removed, never joined to and never read by the engine, so counting it as a
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
    // or being read by the engine. It is text-only and write-once (0342).
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
    // A leftover declaration is a second mechanism waiting to be re-wired. 0342 drops the tables; the
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

  it('entitledDays still resolves from exactly three inputs, and the floor no longer overrides', () => {
    // INVERTED IN r88 (fa3f4ccb), not deleted. This guard's REAL subject is "no FOURTH day-source" — a
    // shared-group day figure must never become an input here. That invariant is unchanged and is still
    // pinned by the signature below.
    //
    // What DID change, deliberately and at the reporter's twice-stated instruction: the statutory floor
    // stops OVERRIDING configuration. It was Math.max(floorDays, schemeDays ?? policyDays); it is now
    // schemeDays ?? policyDays, with floorDays retained SOLELY to raise the below-floor warning. Pinning
    // the old expression here would have re-asserted the behaviour the round was approved to remove.
    // COMMENTS STRIPPED BEFORE MATCHING. The first version of this assertion did not, and failed against
    // the comment two lines above entitledDays that RECORDS the change ("was Math.max(...); the resolved
    // value is now ..."). A guard that greps raw source will eventually match a comment citing the very
    // invariant it protects — r86 hit that four times in one integration. Match code, not prose.
    const code = computeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('const days = schemeDays ?? policyDays;');
    expect(code).not.toContain('Math.max(floorDays, schemeDays ?? policyDays)');
    expect(computeSrc).toMatch(
      /export function entitledDays\(\s*floorDays: number,\s*schemeDays: number \| null,\s*policyDays: number,\s*\): \{ days: number; belowStatutoryFloor: boolean \}/,
    );
    // floorDays must still REACH the caller as a signal, or the warning has no source and the UI would
    // have to recompute the floor — which is how two figures drift apart.
    expect(computeSrc).toContain('belowStatutoryFloor: belowStatutoryFloor(floorDays, days)');
  });

  it('the group carries usage caps and no entitlement bands', () => {
    // scheme_leave_combined_limit holds name + total_limit_days + (r82a, migration 0327) the
    // per-application cap max_days_per_application. Both are limits on what may be TAKEN. Service bands
    // (the day figures) live on scheme_leave_entitlement / leave_policy, per leave type — the group never
    // restates them.
    const block = schemaSrc.slice(
      schemaSrc.indexOf("export const leaveSharedGroup = pgTable"),
      schemaSrc.indexOf("export const leaveSharedGroupMember = pgTable"),
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
      schemaSrc.indexOf("export const leaveSharedGroup = pgTable"),
      schemaSrc.indexOf("export const leaveSharedGroupMember = pgTable"),
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

describe('1ef1cf95 · the group is configured at LEAVE TYPE level, from one labelled control', () => {
  // REWRITTEN IN r88. This block used to assert against the BENEFIT SCHEME config component
  // (`schemeConfigSrc`), because that is where groups lived. The reporter rejected that shape outright
  // — "I don't want to improve the existing Benefit Scheme selector" — so the surface moved to
  // components/leave-shared-group-config.tsx and these assertions moved with it. The INVARIANTS are the
  // ones r82a established and they are unchanged: a labelled way in, and exactly ONE of it.

  it('the group is named, capped and given its members from ONE labelled form', () => {
    expect(groupConfigSrc).toContain("t('nameLabel')");
    expect(groupConfigSrc).toContain("t('membersLabel')");
    expect(groupConfigSrc).toContain("t('maxPerApplicationLabel')");
  });

  it('there is exactly ONE create path, and it is a labelled control rather than a discovered gesture', () => {
    // The reporter originally reported this feature as missing because the only way to reach it was to
    // DRAG one row onto another, with nothing on screen saying so. A labelled form is the fix. Exactly
    // one create action may be posted: a second creation path is a second mechanism, and the one that is
    // not exercised is the one that silently rots.
    expect(groupConfigSrc).toContain("t('createTitle')");
    expect(groupConfigSrc.match(/action=\{actions\.create\}/g) ?? []).toHaveLength(1);
    // …and the drag-to-group gesture really is gone, not merely unused.
    expect(groupConfigSrc).not.toMatch(/onDrop|dragStart|draggable/i);
  });

  it('every locale carries the three shared-group strings', () => {
    // tsc cannot see a missing translation key; six locales, no guard.
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`../messages/${loc}.json`));
      // r88 — the surface moved from admin.benefitScheme to its own admin.leave.sharedGroup namespace
      // when the group stopped being a property of a benefit scheme. Same guard, new home: tsc cannot
      // see a missing translation key, and the i18n coverage check skips multi-namespace files and only
      // matches literal t('key'), so these six locales are not covered anywhere else.
      const g = m.admin.leave.sharedGroup;
      expect(g, `${loc} admin.leave.sharedGroup`).toBeTruthy();
      for (const k of [
        'createTitle',
        'nameLabel',
        'membersLabel',
        'maxPerApplicationLabel',
        'errorAlreadyGrouped',
        'errorNameTaken',
      ]) {
        expect(g[k], `${loc} sharedGroup.${k}`).toBeTruthy();
      }
      // The two refusals the employee actually sees. They must stay DISTINCT in every locale — an
      // employee told the wrong one would fix the wrong thing about their application.
      expect(m.leave.errors.combinedLimitExceeded, `${loc} combinedLimitExceeded`).toBeTruthy();
      expect(m.leave.errors.combinedApplicationTooLong, `${loc} combinedApplicationTooLong`).toBeTruthy();
      expect(m.leave.errors.combinedLimitExceeded, `${loc} refusals must differ`).not.toBe(
        m.leave.errors.combinedApplicationTooLong,
      );
    }
  });
});
