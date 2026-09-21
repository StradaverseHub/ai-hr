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
 * WHAT CHANGED IN r90b, also deliberately and also in the open: the per-application cap is now ONE
 * COMPOSITION OVER TWO SOURCES rather than one source. c6ffa725 asked for "Maximum Consecutive Leave" on
 * the LEAVE TYPE, with a Calendar/Working unit the group cap does not have; r86a shipped only the per-year
 * half and reported the item done, so r90b built the missing half. The assertion that used to forbid a
 * per-type column now pins the composition instead — one function gathers both caps, the stricter binds,
 * the refusal names which one, and each cap may be compared with an application in exactly one place. See
 * the long comment on that test for the full reasoning; the invariant it protects (two configurations must
 * never silently disagree about one application) is unchanged, and the count of ways to CONFIGURE sharing
 * is still one.
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

  /**
   * EXACT SET, EXTENDED ONCE AND NAMED — not loosened.
   *
   * Was ['benefit-scheme.ts', 'leave.ts']; the config half moved OUT of benefit-scheme.ts into a module of
   * its own when the group stopped being a property of a scheme. One that configures, one that enforces.
   *
   * a0b90c81 (r322) adds a THIRD ROLE that did not exist before: a READER. `core/read.ts` consults
   * membership to decide whether a member type still draws its OWN balance card on employee self-service —
   * because if a type's balance IS a placed pool's, a separate card for it says nothing the pooled card
   * does not. That is display, and it is neither configuration nor enforcement.
   *
   * The set is extended rather than the assertion relaxed, and the READER IS CONSTRAINED BELOW: it may
   * only read. The fault this whole file exists to prevent is a SECOND grouping mechanism, which is what a
   * third file that WROTE these tables would be.
   */
  it('only the leave engine, its config module and the display reader touch those tables', () => {
    const coreFiles = readdirSync(resolve(here, '../core')).filter((f) => f.endsWith('.ts'));
    const touching = coreFiles.filter((f) => read(`../core/${f}`).includes('leaveSharedGroupMember'));
    expect(touching.sort()).toEqual(['leave-shared-group.ts', 'leave.ts', 'read.ts']);
  });

  it('the display reader only READS — a third writer would be a second mechanism', () => {
    const src = read('../core/read.ts');
    // Every write verb drizzle offers against these two tables. `read.ts` is a query module; if any of
    // these ever appears there, membership has acquired a second owner and "which group owns this type"
    // stops having one answer.
    for (const table of ['leaveSharedGroupMember', 'leaveSharedGroup']) {
      for (const verb of ['insert', 'update', 'delete']) {
        expect(src, `core/read.ts must never ${verb} ${table}`).not.toMatch(
          new RegExp(`\\.${verb}\\(\\s*${table}\\b`),
        );
      }
    }
    // And it must not re-derive placement: the one resolver is lib/leave-groups.
    expect(src, 'placement is resolved in one place').toContain('resolveSharedGroupPlacement');
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
    // UPDATED AGAIN (6e9a126e release 2), and for the same reason it was inverted in r88: this guard's
    // subject is "NO SHARED-GROUP DAY FIGURE MAY BECOME AN ENTITLEMENT SOURCE", not the literal arity.
    // Release 2 added `templateDays` as a FOURTH input — the entitlement TEMPLATE layer, which is a
    // legitimate day source and the whole point of that item. Pinning "exactly three inputs" would have
    // asserted an implementation detail against the change it was never about. What must stay true is
    // that the fourth input is the template and NOT a shared-group figure, and that the floor still does
    // not override configuration.
    // UPDATED AGAIN (6e9a126e RELEASE THREE), for the FOURTH time and the same reason every time: this
    // guard's subject is "no shared-group day figure may become an entitlement source", never the literal
    // arity. Release three DROPS the scheme and policy layers, so the chain that read
    // `templateDays ?? schemeDays ?? policyDays` is now the template alone. Pinning the old expression
    // would have re-asserted two layers this release exists to delete.
    const code = computeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The chain, in full: the template is now the ONLY configured day source.
    expect(code).toMatch(/templateDays \?\? 0/);
    expect(code, 'the dropped layers must not reappear as day sources').not.toMatch(/schemeDays|policyDays/);
    // The floor advises, it does not override (fa3f4ccb, twice-instructed by the reporter).
    expect(code).not.toMatch(/Math\.max\(\s*floorDays/);
    // 6e9a126e RELEASE THREE — the `entitledDays` SIGNATURE half of this guard is gone because the
    // function is: it existed to resolve floor/template/scheme/policy, and three of those four no longer
    // exist. The guard's REAL subject — "no shared-group day figure may become an entitlement source" —
    // is carried by the chain assertion above, which now also refuses schemeDays/policyDays by name.
    // Removing the whole case would have dropped that; keeping the signature check would have asserted a
    // function that is not there.
    // The floor must still REACH the caller as a signal, or the warning has no source and the UI would
    // have to recompute it — which is how two figures drift apart. The ARGUMENTS changed with the
    // layers (floorDays/days -> p.floorDays/templateDays), the requirement did not.
    expect(computeSrc).toMatch(/belowStatutoryFloor:\s*belowStatutoryFloor\(/);
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

  it('the per-application cap is ONE COMPOSITION, NOT ONE SOURCE (r82a 1ef1cf95, WIDENED by c6ffa725 r90b)', () => {
    // WHAT THIS ASSERTION USED TO SAY, and why it changed. It used to forbid a per-leave-type
    // per-application column outright — the group's max_days_per_application had to be the ONLY place a
    // single application's length was decided. That was the right guard for a world with one scope, and it
    // was written to be changed rather than deleted, in the open, by whoever needed the second one.
    //
    // c6ffa725 needed it. The reporter asked for "Maximum Consecutive Leave" ON THE LEAVE TYPE, with a unit
    // (Calendar Days / Working Days) the group cap does not have. r86a shipped only the per-YEAR half and
    // told them it was done; r90b builds the per-APPLICATION half, which necessarily means a second scope.
    //
    // THE INVARIANT IS UNCHANGED AND IS RE-AIMED, NOT RELAXED. What this file has always protected is that
    // two configurations must never SILENTLY DISAGREE about how much leave one application may take. The
    // fix for that is not "only one may exist" — it is "they are not independent". So:
    //
    //   ONE COMPOSITION, NOT ONE SOURCE. Both caps are gathered, measured and compared in exactly ONE
    //   function, the stricter binds, and the refusal NAMES which limit bound and what it is. That is the
    //   same shape entitledDays has carried for three entitlement sources since 4c48fd1f, asserted two
    //   tests above — a composition is how this codebase already answers "several sources, one answer".
    //
    // A future reader asking "why are two per-application caps allowed here" should be able to answer it
    // from this comment and the three assertions below without opening a plan document.
    const block = schemaSrc.slice(
      schemaSrc.indexOf("export const leaveSharedGroup = pgTable"),
      schemaSrc.indexOf("export const leaveSharedGroupMember = pgTable"),
    );
    // 1. The GROUP's cap still lives on the group. Moving or duplicating it is still forbidden.
    expect(block).toContain("numeric('max_days_per_application'");

    // 2. The leave TYPE's cap is the ONLY other per-application column, and it carries its own UNIT — the
    //    thing that makes it a different rule rather than a rival copy of the group's. COMMENTS STRIPPED
    //    FIRST: this checks COLUMN NAMES, and r86a already proved that grepping raw source turns a comment
    //    correctly CITING the group's column into a phantom violation.
    const leaveTypeBlock = schemaSrc
      // 6e9a126e RELEASE THREE — the end marker was `leavePolicy`, which 0410 drops. indexOf then returned
      // -1 and this slice swallowed the REST OF THE FILE, so the guard started matching columns on tables
      // that legitimately carry them. A boundary naming a deleted symbol does not fail loudly; it silently
      // widens what it inspects. Repointed at the next surviving declaration.
      .slice(schemaSrc.indexOf("export const leaveType = pgTable"), schemaSrc.indexOf("export const jobGrade = pgTable"))
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
      .join('\n');
    // Still forbidden on leave_type: a column NAMED like the group's, or a third invented spelling. Only
    // the two max_consecutive_* columns 0343 added are permitted, and only as a pair.
    expect(leaveTypeBlock).not.toMatch(/max_days_per_application|per_request_limit|max_consecutive_span/);
    expect(leaveTypeBlock).toContain("numeric('max_consecutive_days'");
    expect(leaveTypeBlock).toContain("text('max_consecutive_unit')");

    // 3. THE ASSERTION THAT REPLACES THE OLD PROHIBITION, and the one that actually protects the invariant.
    //    Neither cap may be compared with an application anywhere except inside the single composition. Two
    //    call sites of applicationSpanDays outside it, or a second throw of either refusal, is the silent
    //    disagreement returning — so both refusals must be constructed in exactly ONE place each, and that
    //    place must be the function that ranks the candidates.
    const leaveSrc = read('../core/leave.ts');
    const leaveCode = leaveSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(leaveCode.match(/new CombinedLeaveApplicationTooLongError\(/g) ?? []).toHaveLength(1);
    expect(leaveCode.match(/new LeaveTypeApplicationTooLongError\(/g) ?? []).toHaveLength(1);
    // ONE span helper, giving "consecutive days" its units once. `unit:` is how the per-type reading is
    // selected; a second helper is how the two readings drift apart.
    expect(leaveCode.match(/function applicationSpanDays\(/g) ?? []).toHaveLength(1);
    expect(leaveCode).toMatch(/export function bindingApplicationLengthLimit\(/);
    // Both throws must sit inside the resolver, not scattered through requestLeave and decideLeave. The
    // resolver body is everything from its declaration to the next top-level function.
    const resolver = leaveCode.slice(
      leaveCode.indexOf('async function enforceApplicationLengthLimit('),
      leaveCode.indexOf('async function enforceSharedLeaveGroupLimit('),
    );
    expect(resolver).toContain('new CombinedLeaveApplicationTooLongError(');
    expect(resolver).toContain('new LeaveTypeApplicationTooLongError(');
    // …and the shared-group guard must NOT have kept a copy of the cap it used to own.
    const groupGuard = leaveCode.slice(leaveCode.indexOf('async function enforceSharedLeaveGroupLimit('));
    expect(groupGuard.slice(0, groupGuard.indexOf('export function leaveYearWindow'))).not.toContain(
      'applicationSpanDays(',
    );
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
      // The refusals the employee actually sees. They must stay DISTINCT in every locale — an employee
      // told the wrong one would fix the wrong thing about their application.
      //
      // c6ffa725 r90b adds a THIRD to this set, and it is the one this file's widened guard is really
      // about: leaveTypeApplicationTooLong and combinedApplicationTooLong both mean "this application is
      // too long", but they are fixed in DIFFERENT SCREENS — the leave type, or the shared group. Two caps
      // may be configured at once and only the binding one is thrown, so a locale that let these two
      // collapse into the same sentence would send the employee to the wrong configuration, which is
      // exactly the silent disagreement the single-mechanism rule exists to prevent.
      const refusals = {
        combinedLimitExceeded: m.leave.errors.combinedLimitExceeded,
        combinedApplicationTooLong: m.leave.errors.combinedApplicationTooLong,
        leaveTypeApplicationTooLong: m.leave.errors.leaveTypeApplicationTooLong,
      };
      for (const [k, v] of Object.entries(refusals)) expect(v, `${loc} ${k}`).toBeTruthy();
      expect(new Set(Object.values(refusals)).size, `${loc} all three refusals must differ`).toBe(3);
      // The unit names the third refusal interpolates — a cap with no unit reads as a mistake to an
      // employee who counted the other way (Friday→Monday is 4 calendar days but 2 working days).
      expect(m.leave.errors.consecutiveUnitCalendar, `${loc} consecutiveUnitCalendar`).toBeTruthy();
      expect(m.leave.errors.consecutiveUnitWorking, `${loc} consecutiveUnitWorking`).toBeTruthy();
      expect(m.leave.errors.consecutiveUnitCalendar, `${loc} units must differ`).not.toBe(
        m.leave.errors.consecutiveUnitWorking,
      );
    }
  });
});
