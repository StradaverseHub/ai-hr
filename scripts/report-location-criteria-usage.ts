/**
 * 0fe1ca2e ROUND B, STEP ONE — WHO DOES A SAVED SELECTION REACH if the work-site AXIS goes?
 *
 * The approved plan promises the reporter, in these words: "Before removing anything we will list every
 * saved notice, leave adjustment and template that mentions a work site, and what each one would target
 * afterwards." This is that list. It is the only thing blocking the removal, and it is a DATA question:
 * the answer lives in stored JSONB, not in the source.
 *
 * THE AXIS. `core/org-criteria.ts` ORG_DATED_ASSIGNMENT_CRITERIA carries `{ key: 'locationIds', column:
 * 'locationId' }`. `resolveOrgCriteriaTargets` turns a non-empty `locationIds` into one more AND inside the
 * as-at-`asOf` assignment exists(). Take the entry out of that descriptor and the criteria object still
 * PARSES, the stored key is still there, and the resolver simply stops reading it — so the saved selection
 * silently loses a condition and its population can only ever GET BIGGER. Nothing throws. Nothing warns.
 *
 * READ-ONLY, BY CONSTRUCTION, TWICE OVER — the shape of the two round-A scripts.
 *   (1) This file contains no insert, no update and no delete.
 *   (2) The whole report runs inside `SET TRANSACTION READ ONLY`, so a write introduced here later does
 *       not quietly succeed — Postgres refuses it. Run it on production, during payroll, as often as you
 *       like.
 *
 * ── THE FOUR SURFACES, AND THE DISTINCTION THAT DECIDES HOW MUCH ANY OF THIS MATTERS ──────────────────
 * The brief named three ("notice, leave adjustment, the entitlement / leave-approval templates"). There are
 * FOUR tables carrying an `OrgCriteria` blob, and they are NOT equally dangerous, because only some of them
 * are ever handed back to the resolver again:
 *
 *   entitlement_eligibility_rule.criteria  — ⚠️ LIVE. Re-resolved on EVERY entitlement read:
 *        `buildTemplateEntitlementResolver` (core/entitlement-template.ts:1930) and
 *        `explainEligibility` (:1591) call `resolveOrgCriteriaTargets(tx, { criteria: rule.criteria, … })`
 *        every time somebody opens a balance, runs a grant or asks the alarm sweep. Remove the axis and
 *        the rule's population widens THE NEXT TIME ANYTHING READS IT. This is the surface that can move
 *        leave days, and it is the one the reporter has to decide about.
 *
 *   notice.criteria                        — SPLIT, and the brief has this backwards. db/schema.ts:4759
 *        states the decision in as many words: "publishing RESOLVES the criteria once and persists the
 *        employment ids; notice.criteria is kept alongside purely for disclosure". The audience of a
 *        PUBLISHED notice is the `notice_recipient` snapshot and CANNOT be retargeted by this change.
 *        What still moves is (a) a DRAFT notice, which resolves its audience at publish time and so would
 *        publish to the widened set, and (b) the DISCLOSURE line on a published notice's detail screen,
 *        which would start describing an audience the notice never had.
 *
 *   leave_adjustment_batch.criteria        — FROZEN. Disclosure only (db/schema.ts:2235). The ledger rows
 *        are already written, and `reverseLeaveAdjustmentBatch` (core/leave-adjustment.ts:260) reverses off
 *        those ROWS, never by re-resolving the criteria. Nothing re-reads the blob into the resolver.
 *
 *   leave_generation_run.criteria          — FROZEN, and the brief does not mention it at all. Its own
 *        schema header says it "RECORDS, DECIDES NOTHING… no engine reads either table". Listed here
 *        anyway, because "we did not look" is not a thing this report may say.
 *
 * The leave-approval TEMPLATE has no criteria column of its own: `buildEligibilityRuleScopes`
 * (core/leave-approval-template.ts:569) reads the SAME `entitlement_eligibility_rule` rows. It gets its own
 * flag below rather than its own section — see APPROVAL UNBLOCK.
 *
 * ── WHAT IS NOT A CRITERIA SURFACE, CHECKED RATHER THAN ASSUMED ───────────────────────────────────────
 * `leave_type.eligibility` ({ gender, maritalStatus, minServiceMonths }), `review_cycle.eligibility_rules`
 * ({ companyIds, statuses, employmentTypes, minServiceMonths, hiredBefore }), `payroll_batch.scope`
 * ({ departmentIds, employmentIds }) and `attendance_allowance_policy.criteria` are DIFFERENT vocabularies
 * with no `locationIds` key. Across the whole source tree the literal `locationIds` appears in exactly six
 * places, all of them listed in the round-B brief. `domain_event.payload` is deliberately NOT scanned by
 * default — see `--scan-events`.
 *
 * ── HOW "AFTER" IS COMPUTED, AND WHY IT IS NOT A SECOND MATCHER ───────────────────────────────────────
 * BEFORE and AFTER are the SAME `resolveOrgCriteriaTargets` call, differing only in whether the stored
 * object still carries `locationIds`. Re-expressing the predicate here would be a second copy of the single
 * most consequential predicate in the product, and a second copy that disagreed would produce a reassuring
 * before/after for a change that moves somebody's entitlement. So AFTER = `{ ...criteria }` with
 * `locationIds` deleted, handed to the same resolver, at the same `asOf`.
 *
 * ⚠️ AND THE DIRECTION IS ASSERTED, NOT ASSUMED. An axis can only NARROW, so AFTER ⊇ BEFORE and nobody can
 * be LOST. A row that reports a loss means this script's model of the resolver is wrong, and it is flagged
 * MODEL BROKEN rather than averaged into a total.
 *
 * ── `asOf` IS PER ROW, BECAUSE EVERY AXIS IS EVALUATED AS AT A DATE ───────────────────────────────────
 * `locationIds` is matched against the `assignment` row in force on `asOf`. A report that silently used
 * today for a batch effective in 2024 would answer a different question from the one the row asks. So each
 * row is resolved at the date the engine does (or did) resolve it at, and the file prints which date and
 * why:
 *     entitlement rule, in force / future  → today (or the --asOf override): what changes for you NOW
 *     entitlement rule, superseded         → its last day in force; a BACKDATED entitlement question still
 *                                            reaches it, so it is reported, not skipped
 *     notice, draft                        → today: a draft resolves its audience at publish
 *     notice, published/scheduled/expired  → its publish date: the disclosure line's own date
 *     leave adjustment batch               → its effective_on
 *     leave generation run                 → the UNION of 1 January and `asOfForLeaveYear`, which is
 *                                            exactly the two-legged selection core/leave-generation.ts:295
 *                                            performs, rather than the 1-January leg alone
 *
 * ── TENANT SCOPING IS APPLICATION-LAYER, NOT RLS ──────────────────────────────────────────────────────
 * This runs as the OWNER role so no tenant is invisible, and the owner BYPASSES RLS. `resolveOrgCriteriaTargets`
 * carries no tenant predicate of its own (it was written for a request, where RLS binds it). So every
 * resolution is fed ONLY employment ids read under an explicit `tenant_id =` predicate, passed as the
 * resolver's documented `employmentIds` RESTRICTION — the pattern core/entitlement-alarm.ts:32 spells out
 * for the cron sweeps.
 *
 * ⚠️ AND THE EMPTY LIST IS GUARDED. `employmentIds: []` is NOT "nobody": `nonEmpty([])` is empty, the
 * restriction is never pushed, and the resolver would answer about EVERY TENANT AT ONCE. A tenant with no
 * employments is short-circuited to [] before the call, never handed an empty array.
 *
 * ── THE ONE WAY THIS REPORT CAN LIE, carried over from round A ────────────────────────────────────────
 * Round A's report can print BEFORE(0)/AFTER(0)/NOTHING MOVES for everybody when no gazette is loaded — a
 * perfectly reassuring report about nothing. The same illusion exists here: a tenant with NO employment
 * rows resolves 0 before and 0 after, for every criteria object it owns. That is missing data, not an
 * all-clear, and it is counted and named (EMPTY POPULATION) rather than folded into "nothing widens".
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────────────────────────────
 * Counts to the console; the PER-RECORD list, with the site names and both populations, to a FILE. Copied
 * from the two round-A scripts and from report-a2c-hire-year-deltas.ts: the list names individual saved
 * records and individual employees and belongs in the owner's hands and the reporter's report, not
 * scrolling through an agent's terminal.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-location-criteria-usage.ts [--asOf=YYYY-MM-DD] [--scan-events]
 *
 * `--asOf` moves only the LIVE anchor (today) — a stored row's own date always wins. `--scan-events` adds
 * a sequential scan of `domain_event.payload` for criteria blobs carrying the axis; it is OFF by default
 * because that table is append-only and unbounded, and a full scan on production during payroll is a cost
 * nobody asked this report to pay. Those events are HISTORY and no engine re-resolves them, so the count
 * is informational.
 */
import { writeFileSync } from 'node:fs';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { createDb } from '../db/client';
import { asOfForLeaveYear } from '../core/leave';
import { deriveNoticeStatus } from '../core/notice';
import {
  isUnrestrictedOrgCriteria,
  narrowedOrgCriteriaAxes,
  resolveOrgCriteriaTargets,
  type OrgCriteria,
} from '../core/org-criteria';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  domainEvent,
  employment,
  entitlementEligibilityRule,
  leaveAdjustmentBatch,
  leaveGenerationRun,
  location,
  notice,
  person,
  tenant,
} from '../db/schema';

const args = process.argv.slice(2);
const scanEvents = args.includes('--scan-events');
const asOfArg = args.find((a) => a.startsWith('--asOf='))?.slice('--asOf='.length);
if (asOfArg && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) {
  console.error(`usage: report-location-criteria-usage.ts [--asOf=YYYY-MM-DD] [--scan-events]  (got ${asOfArg})`);
  process.exit(2);
}
/** The LIVE anchor. `todayInKualaLumpur` (lib/hr-date.ts), never a date read off a raw instant. */
const TODAY = asOfArg ?? todayInKualaLumpur();
const OUT = `/var/tmp/location-criteria-usage-${TODAY}.txt`;

/** The one axis under examination. Named once so the report and a future removal cannot drift apart. */
const AXIS = 'locationIds';

/**
 * `ASSIGNABLE_ELIGIBILITY_AXES` in core/leave-approval-template.ts:504, restated rather than imported
 * because it is not exported. Kept adjacent to the flag that uses it so a reader can check it in one place.
 * If that set ever gains `locationIds`, the APPROVAL UNBLOCK flag below becomes wrong — which is why the
 * flag prints the set it tested against.
 */
const ASSIGNABLE_EXPECTED = ['companyIds', 'employmentTypes', 'gradeIds'] as const;

type Reader = 'LIVE' | 'FROZEN' | 'DRAFT';

type Rec = {
  table: string;
  id: string;
  tenantId: string;
  label: string;
  detail: string[];
  /** Every date this row is resolved at. More than one for a generation run (its selection is a union). */
  asOf: string[];
  asOfWhy: string;
  reader: Reader;
  criteria: OrgCriteria;
  siteIds: string[];
};

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role) to read across tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);

  const report = await owner.db.transaction(async (tx) => {
    // Structural read-only. Must be the first statement in the transaction.
    await tx.execute(sql`set transaction read only`);

    // ── INVENTORY: every criteria surface, counted, whether or not it mentions the axis ─────────────
    // `jsonb_exists(col, 'locationIds')` rather than the `?` operator: `?` is a placeholder in several
    // drivers and the function form cannot be misread. A NULL criteria yields NULL and is excluded, which
    // is correct — a null blob names no axis.
    const surveyOf = async (tbl: typeof notice | typeof leaveAdjustmentBatch | typeof entitlementEligibilityRule | typeof leaveGenerationRun, col: never) => {
      const [r] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          withCriteria: sql<number>`count(*) filter (where ${col} is not null)::int`,
          mentions: sql<number>`count(*) filter (where jsonb_exists(${col}, ${AXIS}))::int`,
          nonEmpty: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${col} -> ${AXIS}, '[]'::jsonb)) > 0)::int`,
        })
        .from(tbl);
      return r ?? { total: 0, withCriteria: 0, mentions: 0, nonEmpty: 0 };
    };
    const survey = {
      entitlement_eligibility_rule: await surveyOf(entitlementEligibilityRule, entitlementEligibilityRule.criteria as never),
      notice: await surveyOf(notice, notice.criteria as never),
      leave_adjustment_batch: await surveyOf(leaveAdjustmentBatch, leaveAdjustmentBatch.criteria as never),
      leave_generation_run: await surveyOf(leaveGenerationRun, leaveGenerationRun.criteria as never),
    };

    // ── THE POPULATION: every saved record whose criteria blob NAMES the axis ───────────────────────
    // Rows whose `locationIds` is present but EMPTY are included deliberately. They narrow nobody today —
    // `nonEmpty([])` is empty and the resolver never pushes the condition — so removal is a no-op for
    // them, and a report that silently dropped them would leave the reporter unable to tell "no saved
    // record mentions a site" from "some do, and it happens not to matter".
    const mentions = (col: never) => sql`jsonb_exists(${col}, ${AXIS})`;
    const recs: Rec[] = [];

    // ① entitlement_eligibility_rule — the LIVE one.
    const rules = await tx
      .select({
        id: entitlementEligibilityRule.id,
        tenantId: entitlementEligibilityRule.tenantId,
        name: entitlementEligibilityRule.name,
        lineageId: entitlementEligibilityRule.lineageId,
        templateLineageId: entitlementEligibilityRule.templateLineageId,
        validFrom: entitlementEligibilityRule.validFrom,
        validTo: entitlementEligibilityRule.validTo,
        criteria: entitlementEligibilityRule.criteria,
      })
      .from(entitlementEligibilityRule)
      .where(mentions(entitlementEligibilityRule.criteria as never))
      // Pin an ORDER (CLAUDE.md §8): no asserted list off an unordered query.
      .orderBy(entitlementEligibilityRule.tenantId, entitlementEligibilityRule.validFrom, entitlementEligibilityRule.id);
    for (const r of rules) {
      const c = (r.criteria ?? {}) as OrgCriteria;
      // In force today, or starting later, or already closed. The window is [validFrom, validTo), exactly
      // as core/entitlement-alarm.ts:242 spells it: valid_to is null OR valid_to > asOf.
      const started = r.validFrom <= TODAY;
      const closed = r.validTo != null && r.validTo <= TODAY;
      const asOf = closed ? r.validTo! : started ? TODAY : r.validFrom;
      recs.push({
        table: 'entitlement_eligibility_rule',
        id: r.id,
        tenantId: r.tenantId,
        label: r.name,
        detail: [
          `window     ${r.validFrom} … ${r.validTo ?? 'open'}${closed ? '   (SUPERSEDED — a backdated entitlement question still reaches it)' : started ? '   (IN FORCE TODAY)' : '   (starts in the future)'}`,
          `template   lineage ${r.templateLineageId}`,
        ],
        asOf: [asOf],
        asOfWhy: closed
          ? 'its last day in force — the rule is superseded, but a backdated entitlement question still resolves it'
          : started
            ? 'today — this rule is what the entitlement engine reads on every balance, grant and alarm sweep'
            : 'its start date — the rule is not in force yet, so today would answer about a window it is not in',
        reader: 'LIVE',
        criteria: c,
        siteIds: asArray((c as Record<string, unknown>)[AXIS]),
      });
    }

    // ② notice — draft vs published is the whole distinction.
    const notices = await tx
      .select({
        id: notice.id,
        tenantId: notice.tenantId,
        title: notice.title,
        targetMode: notice.targetMode,
        startOn: notice.startOn,
        endOn: notice.endOn,
        publishedAt: notice.publishedAt,
        archivedAt: notice.archivedAt,
        criteria: notice.criteria,
      })
      .from(notice)
      .where(mentions(notice.criteria as never))
      .orderBy(notice.tenantId, notice.createdAt, notice.id);
    for (const n of notices) {
      // Strip the reserved individual-targeting key exactly as publishNotice (core/notice.ts:289) does
      // before handing the object to the resolver: it lives on the same blob and is not a criteria axis.
      const stored = { ...((n.criteria ?? {}) as OrgCriteria & { employmentIds?: string[] }) };
      delete stored.employmentIds;
      const status = deriveNoticeStatus(n, TODAY);
      const draft = status === 'draft';
      const publishedOn = iso(n.publishedAt);
      recs.push({
        table: 'notice',
        id: n.id,
        tenantId: n.tenantId,
        label: n.title,
        detail: [
          `status     ${status}   ·   window ${n.startOn} … ${n.endOn}   ·   target mode ${n.targetMode}`,
          draft
            ? `AUDIENCE   NOT YET RESOLVED. Publishing this notice runs the resolver — with the axis gone it publishes to the AFTER set.`
            : `AUDIENCE   FROZEN in notice_recipient at publish (${publishedOn ?? 'unknown date'}). Removing the axis cannot retarget it. What changes is the DISCLOSURE line on its detail screen, which would start describing an audience this notice never had.`,
        ],
        asOf: [draft ? TODAY : (publishedOn ?? TODAY)],
        asOfWhy: draft
          ? 'today — a draft resolves its audience at publish, and publish uses the publish date'
          : 'its publish date — the date its snapshot was actually taken at, so the disclosure line is compared against what really happened',
        reader: draft ? 'DRAFT' : 'FROZEN',
        criteria: stored,
        siteIds: asArray((stored as Record<string, unknown>)[AXIS]),
      });
    }

    // ③ leave_adjustment_batch — disclosure only; the ledger is already written.
    const batches = await tx
      .select({
        id: leaveAdjustmentBatch.id,
        tenantId: leaveAdjustmentBatch.tenantId,
        reason: leaveAdjustmentBatch.reason,
        days: leaveAdjustmentBatch.days,
        effectiveOn: leaveAdjustmentBatch.effectiveOn,
        targetMode: leaveAdjustmentBatch.targetMode,
        targetedCount: leaveAdjustmentBatch.targetedCount,
        writtenCount: leaveAdjustmentBatch.writtenCount,
        reversedAt: leaveAdjustmentBatch.reversedAt,
        criteria: leaveAdjustmentBatch.criteria,
      })
      .from(leaveAdjustmentBatch)
      .where(mentions(leaveAdjustmentBatch.criteria as never))
      .orderBy(leaveAdjustmentBatch.tenantId, leaveAdjustmentBatch.createdAt, leaveAdjustmentBatch.id);
    for (const b of batches) {
      recs.push({
        table: 'leave_adjustment_batch',
        id: b.id,
        tenantId: b.tenantId,
        label: b.reason,
        detail: [
          `effective  ${b.effectiveOn}   ·   ${b.days} days   ·   mode ${b.targetMode}   ·   targeted ${b.targetedCount}, written ${b.writtenCount}${b.reversedAt ? '   ·   REVERSED' : ''}`,
          `AUDIENCE   ALREADY WRITTEN. The ledger rows exist; reverseLeaveAdjustmentBatch reverses off those ROWS, never by re-resolving this blob. Removing the axis moves no balance. What changes is what the screen says this batch was AIMED at.`,
        ],
        asOf: [b.effectiveOn],
        asOfWhy: 'its effective date — the date the batch actually resolved its targets at',
        reader: 'FROZEN',
        criteria: (b.criteria ?? {}) as OrgCriteria,
        siteIds: asArray(((b.criteria ?? {}) as Record<string, unknown>)[AXIS]),
      });
    }

    // ④ leave_generation_run — a log with no reader. Named because the brief did not name it.
    const runs = await tx
      .select({
        id: leaveGenerationRun.id,
        tenantId: leaveGenerationRun.tenantId,
        leaveYear: leaveGenerationRun.leaveYear,
        targetMode: leaveGenerationRun.targetMode,
        employeesSelected: leaveGenerationRun.employeesSelected,
        granted: leaveGenerationRun.granted,
        criteria: leaveGenerationRun.criteria,
      })
      .from(leaveGenerationRun)
      .where(mentions(leaveGenerationRun.criteria as never))
      .orderBy(leaveGenerationRun.tenantId, leaveGenerationRun.createdAt, leaveGenerationRun.id);
    for (const g of runs) {
      // The sweep's selection is the UNION of two dated resolutions of the SAME criteria (1 January and
      // the year's late edge) — core/leave-generation.ts:295. Reporting the 1-January leg alone would
      // understate both sides by every mid-year joiner.
      const jan = `${g.leaveYear}-01-01`;
      const late = asOfForLeaveYear(g.leaveYear, TODAY);
      recs.push({
        table: 'leave_generation_run',
        id: g.id,
        tenantId: g.tenantId,
        label: `entitlement year ${g.leaveYear}`,
        detail: [
          `mode ${g.targetMode}   ·   selected ${g.employeesSelected}   ·   granted ${g.granted}`,
          `AUDIENCE   ALREADY GRANTED. This table "RECORDS, DECIDES NOTHING" (db/schema.ts:2213) — no engine reads it back. Removing the axis moves nobody's entitlement through this row.`,
        ],
        asOf: late === jan ? [jan] : [jan, late],
        asOfWhy:
          late === jan
            ? '1 January of the entitlement year — the date the sweep grants on'
            : `the UNION of 1 January (${jan}) and the year's late edge (${late}), which is the two-legged selection the sweep performs`,
        reader: 'FROZEN',
        criteria: (g.criteria ?? {}) as OrgCriteria,
        siteIds: asArray(((g.criteria ?? {}) as Record<string, unknown>)[AXIS]),
      });
    }

    // ── THE SITES THOSE BLOBS NAME. A criteria object can point at a site that no longer exists ──────
    const allSiteIds = [...new Set(recs.flatMap((r) => r.siteIds))];
    const siteRows = allSiteIds.length
      ? await tx
          .select({
            id: location.id,
            tenantId: location.tenantId,
            code: location.code,
            name: location.name,
            state: location.state,
            archivedAt: location.archivedAt,
          })
          .from(location)
          .where(sql`${location.id} in (${sql.join(allSiteIds.map((s) => sql`${s}::uuid`), sql`, `)})`)
      : [];
    const sites = new Map(siteRows.map((s) => [s.id, s]));

    // Tenant names, so the reporter reads a customer rather than a uuid.
    const tenantRows = await tx.select({ id: tenant.id, name: tenant.name }).from(tenant);
    const tenantName = new Map(tenantRows.map((t) => [t.id, t.name]));

    // ── TENANT SCOPING: the employment ids each affected tenant owns, read under an explicit predicate ─
    const tenantIds = [...new Set(recs.map((r) => r.tenantId))];
    const ownedByTenant = new Map<string, string[]>();
    for (const t of tenantIds) {
      const owned = await tx.select({ id: employment.id }).from(employment).where(eq(employment.tenantId, t));
      ownedByTenant.set(t, owned.map((e) => e.id));
    }

    // Employee labels for the delta list — names, not uuids, because this goes to the reporter.
    const labelOf = new Map<string, string>();
    if (tenantIds.length) {
      const people = await tx
        .select({ id: employment.id, code: employment.employeeCode, name: person.fullName, tenantId: employment.tenantId })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(sql`${employment.tenantId} in (${sql.join(tenantIds.map((t) => sql`${t}::uuid`), sql`, `)})`)
        .orderBy(employment.employeeCode, employment.id);
      for (const p of people) labelOf.set(p.id, `${p.code ?? '—'}  ${p.name}`);
    }

    // ── RESOLVE EACH RECORD, BEFORE AND AFTER ───────────────────────────────────────────────────────
    const lines: string[] = [
      `0fe1ca2e — WHO A SAVED SELECTION REACHES, before vs after removing the work-site criteria axis`,
      `generated ${new Date().toISOString()}   ·   live anchor ${TODAY}${asOfArg ? ' (--asOf override)' : ' (todayInKualaLumpur)'}`,
      `READ-ONLY: every figure below comes from core/org-criteria.ts resolveOrgCriteriaTargets, inside a`,
      `SET TRANSACTION READ ONLY transaction. Nothing was written.`,
      ``,
      `BEFORE = who this saved selection resolves to today, with the work-site axis in place.`,
      `AFTER  = who the SAME saved object resolves to once the axis is gone and the stored key is ignored.`,
      `An axis can only narrow, so AFTER can only ever be the same or BIGGER. Nobody can be lost.`,
      ``,
      `CRITERIA SURFACES AS THEY STAND`,
      ...(['entitlement_eligibility_rule', 'notice', 'leave_adjustment_batch', 'leave_generation_run'] as const).map((k) => {
        const s = survey[k];
        return `  ${k.padEnd(30)} rows ${String(s.total).padStart(6)}   with criteria ${String(s.withCriteria).padStart(6)}   naming ${AXIS} ${String(s.mentions).padStart(4)}   …NON-EMPTY ${String(s.nonEmpty).padStart(4)}`;
      }),
      ``,
      `-`.repeat(110),
    ];

    const tally = {
      records: recs.length,
      live: 0,
      draft: 0,
      frozen: 0,
      widens: 0,
      unchanged: 0,
      emptyAxis: 0,
      danglingSite: 0,
      archivedSite: 0,
      crossTenantSite: 0,
      becomesEveryone: 0,
      approvalUnblock: 0,
      emptyPopulation: 0,
      modelBroken: 0,
    };
    let peopleGained = 0;

    for (const r of recs) {
      if (r.reader === 'LIVE') tally.live += 1;
      else if (r.reader === 'DRAFT') tally.draft += 1;
      else tally.frozen += 1;

      const ownedIds = ownedByTenant.get(r.tenantId) ?? [];
      const after: OrgCriteria = { ...r.criteria };
      delete (after as Record<string, unknown>)[AXIS];

      // ⚠️ THE EMPTY-LIST FOOTGUN. `employmentIds: []` is not "nobody" — the restriction is dropped and the
      // resolver answers about every tenant at once. Short-circuit instead.
      const resolveAt = async (c: OrgCriteria, dates: string[]): Promise<Set<string>> => {
        if (ownedIds.length === 0) return new Set();
        const out = new Set<string>();
        for (const d of dates) {
          for (const id of await resolveOrgCriteriaTargets(tx, { criteria: c, asOf: d, employmentIds: ownedIds })) {
            out.add(id);
          }
        }
        return out;
      };
      const beforeSet = await resolveAt(r.criteria, r.asOf);
      const afterSet = await resolveAt(after, r.asOf);

      const gained = [...afterSet].filter((id) => !beforeSet.has(id)).sort();
      const lost = [...beforeSet].filter((id) => !afterSet.has(id)).sort();

      const flags: string[] = [];
      const namedSites = r.siteIds.map((id) => {
        const s = sites.get(id);
        if (!s) return { id, text: `${id}  ⚠ NO SUCH LOCATION ROW` };
        return {
          id,
          text: `${s.code} — ${s.name}  ·  state ${s.state ?? '(none)'}${s.archivedAt ? '  ·  ARCHIVED' : ''}${s.tenantId !== r.tenantId ? '  ·  ⚠ BELONGS TO ANOTHER TENANT' : ''}`,
        };
      });

      if (r.siteIds.length === 0) {
        flags.push(`EMPTY AXIS: the blob carries "${AXIS}" but the list is empty. An empty axis is NO RESTRICTION already (core/org-criteria.ts nonEmpty), so removal is a no-op for this record.`);
        tally.emptyAxis += 1;
      }
      const dangling = r.siteIds.filter((id) => !sites.has(id));
      if (dangling.length) {
        flags.push(`DANGLING SITE: ${dangling.length} of ${r.siteIds.length} site id(s) have NO location row. The axis therefore matches NOBODY today, so this saved selection is already dead — and removing the axis resurrects it onto the full AFTER set. This is the largest jump this change can produce.`);
        tally.danglingSite += 1;
      }
      const archived = r.siteIds.filter((id) => sites.get(id)?.archivedAt);
      if (archived.length) {
        flags.push(`ARCHIVED SITE: ${archived.length} site id(s) point at an archived location (assignment rows may still carry it, so it can still match).`);
        tally.archivedSite += 1;
      }
      const foreign = r.siteIds.filter((id) => sites.has(id) && sites.get(id)!.tenantId !== r.tenantId);
      if (foreign.length) {
        flags.push(`CROSS-TENANT SITE: ${foreign.length} site id(s) belong to a DIFFERENT tenant than the record. That is a data fault in its own right and should be reported whatever happens to this axis.`);
        tally.crossTenantSite += 1;
      }
      if (!isUnrestrictedOrgCriteria(r.criteria) && isUnrestrictedOrgCriteria(after)) {
        flags.push(`WIDENS TO EVERYONE: the work site was the ONLY axis this record narrows by. With it gone the criteria object is empty, which core/org-criteria.ts documents as "every active employment". This is the shape the plan warned the reporter about, in as many words.`);
        tally.becomesEveryone += 1;
      }
      if (r.table === 'entitlement_eligibility_rule' && r.reader === 'LIVE') {
        const unexpressible = narrowedOrgCriteriaAxes(r.criteria).filter((a) => !(ASSIGNABLE_EXPECTED as readonly string[]).includes(a));
        const after_ = narrowedOrgCriteriaAxes(after).filter((a) => !(ASSIGNABLE_EXPECTED as readonly string[]).includes(a));
        if (unexpressible.length > 0 && after_.length === 0) {
          flags.push(`APPROVAL UNBLOCK: today buildEligibilityRuleScopes (core/leave-approval-template.ts:579) REFUSES this rule for approval-template assignment, because it narrows by [${unexpressible.join(', ')}] and an approval rule has no column to scope on — assignable axes are [${ASSIGNABLE_EXPECTED.join(', ')}]. Remove the site axis and the refusal disappears: the rule becomes silently assignable, and assigning it would give the template to employees the rule was written to leave out.`);
          tally.approvalUnblock += 1;
        }
      }
      if (ownedIds.length === 0) {
        flags.push(`EMPTY POPULATION: this tenant has NO employment rows at all, so BEFORE(0) and AFTER(0) are missing data, NOT evidence. Exactly the trap round A's report calls EMPTY GAZETTE. Do not read this record as an all-clear.`);
        tally.emptyPopulation += 1;
      }
      if (lost.length > 0) {
        flags.push(`⛔ MODEL BROKEN: ${lost.length} employment(s) are in BEFORE but not in AFTER. An axis can only narrow, so removing one cannot lose anybody. Either the resolver's semantics are not what this report believes, or the two resolutions did not run at the same date. Do NOT act on this report until this is explained.`);
        tally.modelBroken += 1;
      }

      const widens = gained.length > 0;
      if (widens) {
        tally.widens += 1;
        peopleGained += gained.length;
      } else {
        tally.unchanged += 1;
      }

      // Rendered for a HUMAN, so the lists are ordered by the employee code the reporter reads, not by the
      // uuid the resolver returns. `gained`/`lost` are still computed off the id sets above — the sort is
      // presentation and decides nothing.
      const named = (ids: Iterable<string>) =>
        [...ids].map((id) => labelOf.get(id) ?? id).sort((a, z) => a.localeCompare(z));

      lines.push(
        ``,
        `${r.table.toUpperCase()}   ${r.label}`,
        `id         ${r.id}`,
        `tenant     ${tenantName.get(r.tenantId) ?? '(unnamed)'}  [${r.tenantId}]`,
        ...r.detail.map((d) => d),
        `re-read?   ${r.reader}${r.reader === 'LIVE' ? '  — the engine resolves this blob again every time it is asked. THIS IS THE SURFACE THAT MOVES.' : r.reader === 'DRAFT' ? '  — not yet resolved; publishing it after the removal publishes to the AFTER set.' : '  — the outcome is already written; only the disclosure text changes.'}`,
        `resolved at ${r.asOf.join(' + ')}   (${r.asOfWhy})`,
        `narrows by  ${narrowedOrgCriteriaAxes(r.criteria).join(', ') || '(nothing — this object means EVERYONE already)'}`,
        `WORK SITES${namedSites.length ? '' : '  (none listed)'}`,
        ...namedSites.map((s) => `   · ${s.text}`),
        `VERDICT     ${widens ? `WIDENS — ${beforeSet.size} → ${plural(afterSet.size, 'employment', 'employments')} (+${gained.length})` : `UNCHANGED — ${plural(beforeSet.size, 'employment', 'employments')} before and after`}`,
      );
      for (const f of flags) lines.push(`⚠ ${f}`);
      lines.push(
        ``,
        `  BEFORE (${plural(beforeSet.size, 'employment', 'employments')})`,
        ...named(beforeSet).map((l) => `    ${l}`),
        `  AFTER  (${plural(afterSet.size, 'employment', 'employments')})`,
        ...named(afterSet).map((l) => `    ${l}`),
      );
      if (gained.length) {
        lines.push(
          `  NEWLY INCLUDED (${gained.length}) — these people are reached by this saved selection only AFTER the axis goes:`,
          ...named(gained).map((l) => `    + ${l}`),
        );
      }
      if (lost.length) {
        lines.push(`  ⛔ LOST (${lost.length}) — impossible under the documented semantics; see MODEL BROKEN above:`, ...named(lost).map((l) => `    - ${l}`));
      }
      lines.push(`-`.repeat(110));
    }

    if (recs.length === 0) {
      lines.push(
        ``,
        `NO saved notice, leave adjustment, entitlement rule or generation run names the work-site axis.`,
        `Removing it changes who NOTHING targets. The removal is straightforward on this evidence — subject`,
        `to the two counts above being non-zero, i.e. to there being saved records to have looked at.`,
      );
    }

    // ── OPTIONAL: history. Informational — no engine re-resolves a domain event's payload ────────────
    let events: number | null = null;
    if (scanEvents) {
      const [e] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(domainEvent)
        .where(and(isNotNull(domainEvent.payload), sql`${domainEvent.payload}::text like ${'%' + AXIS + '%'}`));
      events = e?.n ?? 0;
      lines.push(
        ``,
        `DOMAIN EVENTS mentioning "${AXIS}" in their payload: ${events}`,
        `These are HISTORY. No engine re-resolves an event payload, so removing the axis cannot change what`,
        `any of them targeted. They are counted because a renderer that stops understanding the key would`,
        `show a past event with a condition missing — which is the same class of defect as removing the`,
        `movement renderer while the deltas still carry locationId.`,
      );
    }

    lines.push(
      ``,
      `=`.repeat(110),
      `records naming the axis: ${tally.records}   (LIVE ${tally.live} · DRAFT ${tally.draft} · FROZEN ${tally.frozen})`,
      `WIDENS: ${tally.widens}   unchanged: ${tally.unchanged}   employments newly included, summed over records: ${peopleGained}`,
      `empty-axis: ${tally.emptyAxis}   dangling-site: ${tally.danglingSite}   archived-site: ${tally.archivedSite}   cross-tenant-site: ${tally.crossTenantSite}`,
      `becomes-everyone: ${tally.becomesEveryone}   approval-unblock: ${tally.approvalUnblock}   EMPTY POPULATION: ${tally.emptyPopulation}   MODEL BROKEN: ${tally.modelBroken}`,
    );
    writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

    return { survey, tally, peopleGained, events };
  });

  // Console gets COUNTS ONLY — the list names saved records and individual employees and belongs in the
  // file, not in a terminal.
  const s = report.survey;
  const t = report.tally;
  console.log(`work-site criteria axis ("${AXIS}") — saved-selection impact, anchor ${TODAY}`);
  console.log(`  entitlement rules  : ${s.entitlement_eligibility_rule.total} rows, ${s.entitlement_eligibility_rule.mentions} name the axis (${s.entitlement_eligibility_rule.nonEmpty} non-empty)   <-- the LIVE surface`);
  console.log(`  notices            : ${s.notice.total} rows, ${s.notice.mentions} name the axis (${s.notice.nonEmpty} non-empty)`);
  console.log(`  adjustment batches : ${s.leave_adjustment_batch.total} rows, ${s.leave_adjustment_batch.mentions} name the axis (${s.leave_adjustment_batch.nonEmpty} non-empty)`);
  console.log(`  generation runs    : ${s.leave_generation_run.total} rows, ${s.leave_generation_run.mentions} name the axis (${s.leave_generation_run.nonEmpty} non-empty)`);
  console.log(`  records to review  : ${t.records}   (LIVE ${t.live} · DRAFT ${t.draft} · FROZEN ${t.frozen})`);
  console.log(`  WIDENS             : ${t.widens}${t.widens ? '   <-- these are the ones to put in front of the reporter' : ''}`);
  console.log(`  unchanged          : ${t.unchanged}`);
  console.log(`  employments newly included (summed): ${report.peopleGained}`);
  console.log(`  becomes EVERYONE   : ${t.becomesEveryone}${t.becomesEveryone ? '   <-- the site was the only narrowing axis on these' : ''}`);
  console.log(`  dangling site id   : ${t.danglingSite}${t.danglingSite ? '   <-- matches nobody today; removal resurrects the record onto the full set' : ''}`);
  console.log(`  archived site      : ${t.archivedSite}`);
  console.log(`  cross-tenant site  : ${t.crossTenantSite}${t.crossTenantSite ? '   <-- a data fault regardless of this change' : ''}`);
  console.log(`  empty axis (no-op) : ${t.emptyAxis}`);
  console.log(`  approval UNBLOCK   : ${t.approvalUnblock}${t.approvalUnblock ? '   <-- these rules are REFUSED for approval templates today and would silently become assignable' : ''}`);
  console.log(`  EMPTY POPULATION   : ${t.emptyPopulation}${t.emptyPopulation ? '   <-- NOT evidence: the tenant has no employments, so before==after proves nothing' : ''}`);
  console.log(`  MODEL BROKEN       : ${t.modelBroken}${t.modelBroken ? '   <-- STOP. An axis cannot lose anybody. Do not act on this report.' : ''}`);
  if (report.events != null) console.log(`  domain events naming the axis (history, informational): ${report.events}`);
  console.log(`  per-record list    : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
