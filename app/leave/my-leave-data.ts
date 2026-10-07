/**
 * r397 — EVERY READ THE MY LEAVE PAGE (app/leave/page.tsx) MAKES, and the order they may run in.
 *
 * Until r397 the page awaited these one after another, so a visit cost the SUM of their latencies (measured on
 * the seeded database: 204 statements in 39 transactions, end to end ~130 ms locally, ~530 ms on the box). Most
 * of them do not depend on each other at all, so they now start together and the page waits for the LONGEST
 * chain instead. Nothing here computes a figure: every value is what the same function, called with the same
 * arguments, returned before — test/r397-my-leave-equivalence.test.ts compares this loader, deep-equal, against
 * the pre-r397 sequence kept verbatim in test/fixtures/r397-leave-before.ts.
 *
 * ── THE DEPENDENCY GRAPH (every edge is a value one read hands the next) ──────────────────────────────────────
 *
 *   catalogue = listEmployees ∥ listLeaveTypes ∥ listEligibleLeaveTypesFor     (already concurrent before r397)
 *     ├─ employees → myCompanyId → canApplyLeaveOnBehalf(myCompanyId)
 *     └─ leaveTypes, eligibleTypeIds → (the page's pure derivations only)
 *   replacementRequestAvailability(today) → .allowed → leaveCreditOfferForEmployment      (only when allowed)
 *   myLeaveDashboard(leaveYear)
 *     ├─ .cards has a Replacement Leave card → replacementLeaveLedger ∥ listReplacementLeaveRequests
 *     └─ .selectedYear → leaveYearAsOf → sharedLeaveGroupBalances(asOf)   (see SPECULATION below)
 *   loadOwnUpcomingLeave(sp)                                               (no input from any read above)
 *
 * Four independent chains, started together; inside each, the edges above are kept. Each read keeps its OWN
 * transaction — no two are merged — so what each one sees, and its RLS context, is exactly what it was.
 *
 * ── SPECULATION, AND WHY IT CANNOT CHANGE A FIGURE ─────────────────────────────────────────────────────────────
 * `sharedLeaveGroupBalances` needs `leaveYearAsOf`, which is `${selectedYear}-12-31` when the dashboard selected a
 * year other than the current one, else `today`. `resolveSelectedLeaveYear` (core/my-leave.ts) returns the
 * current year for an ABSENT, a MALFORMED or the CURRENT year's `?leaveYear=` WITHOUT consulting the offered
 * years — so for those three, which are every visit that did not touch the Year selector, asOf is `today` and is
 * known before the dashboard is read. Only then does the pool read start early. It is then CHECKED against the
 * dashboard's own answer: should they ever disagree, the early result is discarded and the read is made again
 * with the dashboard's asOf, exactly as before. A visit that picked an earlier year waits for the dashboard.
 *
 * ── FAN-OUT ───────────────────────────────────────────────────────────────────────────────────────────────────
 * At most six transactions start at once from here (the three catalogue reads, availability, the dashboard, the
 * shared-group read) plus the Upcoming chain; the app pool is 10 (db/client.ts). The dashboard's own per-type
 * work is batched inside its read (core/my-leave.ts), so it no longer opens a transaction per leave type.
 */
import type { SessionContext } from '@/db/client';
import { listEmployees, listLeaveTypes, listEligibleLeaveTypesFor, replacementLeaveLedger, myEmployment } from '@/core/read';
import { canApplyLeaveOnBehalf } from '@/core/leave';
import { myLeaveDashboard } from '@/core/my-leave';
import { sharedLeaveGroupBalances } from '@/core/leave-shared-group';
import { leaveCreditOfferForEmployment, listReplacementLeaveRequests, replacementRequestAvailability } from '@/packs/leave/service';
import { loadOwnUpcomingLeave, type HistorySearch } from '@/components/leave/own-leave-history';
import { isReplacementLeaveType } from '@/core/ess-view';

type Me = NonNullable<Awaited<ReturnType<typeof myEmployment>>>;

/** The page's own expression (app/leave/page.tsx before r397), kept as one function so both uses agree. */
function leaveYearAsOfFor(dashboard: { selectedYear: number; currentYear: number }, today: string): string {
  return dashboard.selectedYear !== dashboard.currentYear ? `${dashboard.selectedYear}-12-31` : today;
}

/**
 * The asOf `sharedLeaveGroupBalances` will be asked for, when it is decided WITHOUT reading anything: an absent,
 * malformed or current-year `?leaveYear=` makes `resolveSelectedLeaveYear` return the current year before it
 * looks at the offered years at all, so `leaveYearAsOfFor` is `today`. Null ⇒ only the dashboard can say.
 */
function leaveYearAsOfWithoutReading(rawYear: string | undefined, today: string): string | null {
  const currentYear = Number(today.slice(0, 4));
  const resolvesToCurrentUnread = rawYear == null || !/^\d{4}$/.test(rawYear) || Number(rawYear) === currentYear;
  return resolvesToCurrentUnread ? today : null;
}

export async function loadMyLeave(p: {
  session: SessionContext;
  scopeIds: string[] | undefined;
  me: Me;
  sp: HistorySearch & { leaveYear?: string };
  locale: string;
  today: string;
}) {
  const { session, scopeIds, me, sp, locale, today } = p;

  // Chain 1 — the catalogue, then the on-behalf question that needs the viewer's company from it.
  // MOVED FROM app/leave/page.tsx with the read (r397), comments and all.
  const catalogueP = Promise.all([
    listEmployees(session, scopeIds),
    // Employee apply-popup enhancement: pass the viewer's locale so listLeaveTypes localizes `name` through
    // pickName. Without it the list is always English, which also makes an alphabetical sort meaningless
    // outside English. Admin master screens deliberately keep passing no locale (they edit the English name).
    //
    // ad965821 — THE FULL CATALOGUE IS STILL READ, and deliberately: two consumers on this page need it and
    // would break silently on the narrowed list. (1) `unpaidTypeName` just below, which supplies the
    // tenant's own name for unpaid leave to the fef49b9a balance split — UNPAID is a plausible hidden or
    // not-can-apply type, so filtering it away would drop that name from the breakdown. (2) the
    // EditLeaveDialog list, which must keep a request's OWN type selectable even when the employee no
    // longer qualifies for it. What it no longer feeds is the apply dropdown.
    //
    // ec991c2a — `includeArchived: false` written out, and it is already `listLeaveTypes`' default
    // (core/read.ts: `.where(opts.includeArchived ? undefined : isNull(leaveType.archivedAt))`). The item's
    // build notes read this call as the one deciding the apply list; it is NOT — see the line below. It
    // feeds `unpaidTypeName`, the EditLeaveDialog list and the replacement-leave notice, all of which want
    // the live catalogue. Stated explicitly so the next reader does not have to go and check the default.
    listLeaveTypes(session, { locale, includeArchived: false }),
    // …which now comes from HERE: the types this employee actually qualifies for, resolved through the ONE
    // gate in core/read.ts (conditions + employee_can_apply + hidden placement). An ineligible type is
    // ABSENT — no message, no greyed row, no badge, no count. requestLeave still refuses the submission.
    listEligibleLeaveTypesFor(session, me.employmentId, locale),
  ]).then(([employees, leaveTypes, eligibleLeaveTypes]) => {
    // Sort ONCE, at the source (app/leave/page.tsx explains why), before anything reads them.
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name, locale, { sensitivity: 'base' });
    leaveTypes.sort(byName);
    eligibleLeaveTypes.sort(byName);
    return { employees, leaveTypes, eligibleLeaveTypes };
  });
  const canApplyOnBehalfP = catalogueP.then(({ employees }) => {
    // Company-scoped: the viewer's OWN company, off the employee list (`me` does not carry the id).
    const myCompanyId = employees.filter((e) => !e.terminatedOn).find((e) => e.employmentId === me.employmentId)?.companyId ?? null;
    return canApplyLeaveOnBehalf(session, myCompanyId);
  });

  // Chain 2 — may this employee ask for replacement leave, then (only if so) the Leave Credit offer.
  const replacementRequestP = replacementRequestAvailability(session, me.employmentId, today);
  const leaveCreditOfferP = replacementRequestP.then((r) =>
    r.allowed ? leaveCreditOfferForEmployment(session, me.employmentId) : null,
  );

  // Chain 3 — the dashboard, then what its cards and its selected year decide.
  const dashboardP = myLeaveDashboard(session, me.employmentId, { today, year: sp.leaveYear, locale });
  const replacementP = dashboardP.then(async (dashboard) => {
    const replacementCard = dashboard.cards.find((c) => isReplacementLeaveType(c));
    if (!replacementCard) return { replacementLedger: null, replacementRequests: [] as Awaited<ReturnType<typeof listReplacementLeaveRequests>> };
    const [replacementLedger, replacementRequests] = await Promise.all([
      replacementLeaveLedger(session, me.employmentId),
      listReplacementLeaveRequests(session, me.employmentId),
    ]);
    return { replacementLedger, replacementRequests };
  });
  const sharedFor = (asOf: string) => sharedLeaveGroupBalances(session, me.employmentId, { locale, asOf });
  const knownAsOf = leaveYearAsOfWithoutReading(sp.leaveYear, today);
  const earlySharedP = knownAsOf != null ? sharedFor(knownAsOf) : null;
  // Should the early read be discarded below, its failure must not surface as an unhandled rejection; when it
  // IS used, it is awaited through `sharedP` and fails the page exactly as the sequential read did.
  earlySharedP?.catch(() => undefined);
  const sharedP = dashboardP.then((dashboard) => {
    const asOf = leaveYearAsOfFor(dashboard, today);
    // The early read is used only when it was asked for the very asOf the dashboard now names.
    return earlySharedP != null && asOf === knownAsOf ? earlySharedP : sharedFor(asOf);
  });

  // Chain 4 — Upcoming Leave and the history filter the Year form carries (no input from the chains above).
  const upcomingP = loadOwnUpcomingLeave({ session, me, sp });

  const [catalogue, canApplyOnBehalf, replacementRequest, leaveCreditOffer, dashboard, replacement, sharedGroupBalances, own] =
    await Promise.all([
      catalogueP,
      canApplyOnBehalfP,
      replacementRequestP,
      leaveCreditOfferP,
      dashboardP,
      replacementP,
      sharedP,
      upcomingP,
    ]);
  return {
    employees: catalogue.employees,
    leaveTypes: catalogue.leaveTypes,
    eligibleLeaveTypes: catalogue.eligibleLeaveTypes,
    canApplyOnBehalf,
    replacementRequest,
    leaveCreditOffer,
    dashboard,
    leaveYearAsOf: leaveYearAsOfFor(dashboard, today),
    replacementLedger: replacement.replacementLedger,
    replacementRequests: replacement.replacementRequests,
    sharedGroupBalances,
    upcoming: own.upcoming,
    historyFilterParams: own.historyFilterParams,
  };
}
