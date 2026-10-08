/**
 * THE SERVICE-DEEP MODULE GATE — one import line per service file, every entry point in it gated.
 *
 * ADR-0077 D3 says enforcement lives at the SERVICE boundary and that the route guard
 * (`lib/authz.ts requireModule`) is "a courtesy, not a control". Until r292 that was aspirational:
 * `assertModuleEnabled` had FOUR call sites in `core/` (assistant-grant, replacement-request ×2,
 * schema-explorer) and `requireModule` guarded SEVEN of 198 `page.tsx` files. Measured on
 * main@c3ba27bf, the four optional packs looked like this — pages in the pack's route trees vs pages
 * carrying a module check:
 *
 *     attendance   23 pages,  3 checked        claims         6 pages,  1 checked
 *     payroll      57 pages,  1 checked        performance    4 pages,  1 checked
 *
 * So a customer who declined Payroll could reach 56 of its 57 screens by typing the URL, and every
 * server action behind them, because nothing below the page refused.
 *
 * WHY THIS IS A MECHANISM AND NOT 86 MORE PAGE-LEVEL CALLS
 * -------------------------------------------------------
 * The same argument db/client.ts makes for slice 9's suspension overlay ("SUSPENSION IS A MECHANISM,
 * NOT A DISCIPLINE … doing it per action would mean auditing several hundred call sites and
 * re-auditing every new one forever; one line here binds all of them, including code written next
 * year"). A per-page or per-function guard is one forgotten import away from a hole, and this repo has
 * 198 pages and growing.
 *
 * Every read and every write in this codebase goes through `withTenant` — core/read.ts's first line
 * says so ("Each runs via withTenant, so RLS scopes every result"). A module's service file imports
 * `withTenant` on exactly ONE line. Rebinding that line to a module-bound wrapper gates every function
 * in the file at once, and every function ADDED to it later, with nothing for a future author to
 * remember. `core/payroll.ts` alone carries 38 exported entry points behind one such line.
 *
 * WHERE IT IS APPLIED (and why only there) — see each file's import line:
 *
 *     core/claims.ts        → claims        (packs/claims/index.ts: "the whole module in one service")
 *     core/performance.ts   → performance   (packs/performance/index.ts: same)
 *     core/attendance.ts    → attendance    (the pack's primary service)
 *     core/payroll.ts       → payroll       (packs/payroll/index.ts: "THE ENGINE")
 *     core/payroll-view.ts  → payroll       (the processed-payslip read models)
 *     core/tax-relief.ts    → payroll       (r294 — the TP1 declare/submit/approve path)
 *     core/back-pay.ts      → payroll       (r294 — arrears detect/calculate/verify/approve-and-post)
 *
 * THE OTHER FOUR PAYROLL SERVICE FILES ARE UNBOUND ON PURPOSE (r292 stated the gap; r294 did the
 * importer audit and closed two of the six). The audit parsed every import, export-from, dynamic import
 * and require in the repo rather than grepping, because a grep is wrong in both directions here: it
 * reports doc comments that quote a specifier as real edges, and it misses the edge that actually
 * decides this — core/admin.ts reaches core/payroll-cycle.ts through the pack facade, not by name.
 *
 *     core/pay-components.ts  LEFT — app/admin/personnel/[employmentId] (PERSONNEL, a core screen)
 *                                    calls listEmploymentPayComponents + listPayComponents
 *                                    unconditionally for any admin, and core/attendance-allowance.ts
 *                                    — the ATTENDANCE pack — writes through setPayrollBatchComponent.
 *                                    Binding it refuses a tenant that bought Attendance and not Payroll.
 *     core/cp38.ts            LEFT — the same Personnel page calls listCp38 unconditionally.
 *     core/loans.ts           LEFT — app/me/page.tsx (ESS, core) calls listLoansForEmployment.
 *     core/payroll-cycle.ts   LEFT — app/admin/organization/[companyId] (core) calls listPayrollCycles,
 *                                    and core/admin.ts seeds the cycle catalogue when a company is
 *                                    created. The seeder passes its own `tx`, so the rebinding would
 *                                    not catch THAT call — but the Organization read has no handle and
 *                                    would break outright.
 *
 * Each of those needs a NARROWER seam than the file (a per-function assertion at the write entry
 * points, or making the core screen ask before it reads), not this one. test/module-gate.test.ts pins
 * both halves: the two bindings refuse and work, and the four non-bindings still answer for a tenant
 * with every optional module off — so binding one of them turns that test red rather than a customer.
 *
 * r298 (board ceb1c560) BUILT THE SECOND SEAM FOR THE THREE CORE SCREENS: Personnel, Organization and
 * My Profile now ask `isModuleEnabledOrFalse(s, 'payroll')` once and do not CALL those reads for a tenant
 * without Payroll (test/r298-payroll-sections-gate.test.ts). The screen blockers named above are therefore
 * gone; the files stay unbound because binding is a separate change, and two things still stand in its way:
 *   - core/admin.ts's cycle seeder (above) — unaffected, it passes a `tx`;
 *   - for core/pay-components.ts, the ATTENDANCE pack. Measured at r298, the edge that actually bites is the
 *     READ in app/admin/attendance-allowance/page.tsx (`listSupportedBatchComponents`, no handle). The write
 *     named above does not: core/attendance-allowance.ts passes its own `tx` to setPayrollBatchComponent,
 *     so a file rebinding would not reach it, and its only caller is app/payroll/actions.ts.
 *
 * NOT core/read.ts, and that is the whole reason this file reasons about placement rather than
 * spraying calls. `read.ts` is the SHARED kernel read module: `dashboardStats` reads `payroll_batch`
 * AND attendance in the same function, and the dashboard is a CORE screen. Gating it would break
 * Personnel, Leave and the dashboard for a tenant that declined every optional pack — worse than the
 * hole it closes. The same test rules out `core/comp.ts`, `core/holidays.ts` and `core/roster.ts`
 * (declared spine by packs/payroll/index.ts and packs/attendance/index.ts respectively).
 *
 * WHICH MODULES ARE GATEABLE. Exactly the ones `packs/catalog.ts` marks `isCore: false`. The catalog
 * is the source of truth and the constructor below enforces it: passing a core code (`employees`,
 * `org`, `leave`, `ess`, `approvals`, `knowledge_base`) throws at module load, so the failure mode
 * this change most plausibly causes — gating a chokepoint a core screen depends on — cannot be
 * introduced by a typo.
 *
 * WHAT IT DOES NOT GATE, DELIBERATELY
 * -----------------------------------
 * 1. **A `tx`-taking helper.** `currentAdminManager(tx, …)` (performance), `resolveBatchScopeFilter(tx, …)`
 *    and `markBatchNeedsRecalc(tx, ctx, …)` (payroll) take a handle rather than opening one, so they are
 *    untouched by the rebinding. That is correct and load-bearing: `core/employment-review.ts` (spine)
 *    and `core/attendance-recompute.ts` call exactly those, and a tenant without Performance or Payroll
 *    must keep its employment-review and attendance-correction paths.
 * 2. **A BOOTSTRAP context** — one carrying an `entitlementsExempt` marker. `db/seed.ts` drives
 *    `checkIn`/`checkOut`/`createCycle`/`submitManagerReview` and `db/provision.ts` drives
 *    `seedPayrollCycleCatalog` through contexts that have no commercial identity because none can exist
 *    yet: the tenant is being created. `assertModuleEnabled` throws `EntitlementsExemptForBillableError`
 *    for those by design (slice 3), so gating them would break `pnpm db:seed`, the test template build,
 *    `cleanroom-verify.sh` and provisioning itself.
 *
 *    THIS IS NOT THE BYPASS SLICE 3 CLOSED, and the distinction matters. That bug was `isModuleEnabled`
 *    ANSWERING TRUE for an exempt context, so `scripts/review-sweep.ts` silently dispatched a billable
 *    feature for tenants that never bought it. Nothing here answers a question: the gate simply is not
 *    the layer that decides for a context with no commercial identity, and `assertModuleEnabled` keeps
 *    throwing for anyone who asks it directly. A marked context is also NOT WEB-REACHABLE:
 *    `lib/session.ts` never sets the marker (grep it), so no browser request can acquire one. And the
 *    coverage is strictly wider than before this change, never narrower — an exempt sweep gets exactly
 *    today's behaviour. A sweep that SHOULD be gated carries a real snapshot instead of the marker, as
 *    `scripts/review-sweep.ts` and `scripts/backfill-backup-shift.ts` already do and document.
 *
 * WHAT IT DOES REFUSE, and why that is right:
 *
 *  - a resolved snapshot without the module ⇒ `ModuleNotEnabledError`. The point of the change.
 *  - `entitlementsError` (the resolver failed) ⇒ `EntitlementsResolutionFailedError`. A service-level
 *    read is an AUTHORIZATION decision and "I could not find out" must be LOUD — core/entitlements.ts
 *    draws that line and `isModuleEnabledOrFalse`'s header states it. This is the opposite of
 *    `requireModule`'s deliberate fail-OPEN, which is a REDIRECT decision: bouncing a paying customer to
 *    a dashboard during an infrastructure incident would tell them their module had been removed. Both
 *    are correct because they answer different questions; the route guard stays exactly as it is.
 *  - a synthetic context with neither a snapshot nor a marker ⇒ `EntitlementsUnresolvedError`, which is
 *    the resolver's existing answer for a mis-wired caller.
 *
 * COMPANY SCOPE. `tenant_module` can be company-scoped (`scripts/module-change-runner.ts` writes
 * `company_id`), and this layer has no company in hand — it sits under every screen, not beside one. It
 * therefore asks the tenant-wide question, exactly as `requireModule` (lib/authz.ts) and
 * `visibleModuleCodes` (lib/nav-entitlements.ts) already do, so a scoped-only grant reads as OFF in all
 * three places rather than in two of three. Verified inert on production 2026-09-16: all nine
 * `tenant_module` rows are tenant-wide (`company_id is null`). A genuine per-company entitlement needs a
 * gate that knows the company, which is a different change; this one must not pretend to be it.
 */
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { CORE_MODULE_CODES, MODULE_CATALOG } from '../packs/catalog';
import { assertModuleEnabled, type EntitledContext } from './entitlements';

const CORE = new Set<string>(CORE_MODULE_CODES);
const CATALOGUED = new Set<string>(MODULE_CATALOG.map((m) => m.code));

/**
 * Refuse unless the tenant may use `code` — the assertion `withModuleTenant` is built from, exported
 * so a caller that already holds a `tx` (or renders rather than queries) can ask the same question.
 *
 * Returns without asking for a bootstrap context; see this file's header for why that is not the
 * slice-3 bypass.
 */
export function assertModuleGate(ctx: SessionContext, code: string): void {
  if ((ctx as EntitledContext).entitlementsExempt !== undefined) return;
  assertModuleEnabled(ctx as EntitledContext, code);
}

/**
 * Bind a module code to `withTenant`. The returned function is signature-identical, so a service file
 * adopts it by rewriting its ONE `withTenant` import — no call site changes, no partial adoption.
 *
 * Throws at module load for an unknown or CORE code: the catalogue decides what is optional, and a
 * core module has no "off" state to gate on.
 */
export function withModuleTenant(code: string) {
  if (!CATALOGUED.has(code)) {
    throw new Error(`withModuleTenant('${code}'): not a module in MODULE_CATALOG (packs/catalog.ts).`);
  }
  if (CORE.has(code)) {
    throw new Error(
      `withModuleTenant('${code}'): '${code}' is a CORE module (isCore: true in packs/catalog.ts). ` +
        `A core module is never sold and never disabled — gating one would take Personnel, Leave or the ` +
        `dashboard away from a tenant that declined every optional pack.`,
    );
  }
  // `async`, and that is NOT cosmetic. The first version was a plain function that called
  // `assertModuleGate` before returning `withTenant(...)`, so a refusal escaped SYNCHRONOUSLY out of a
  // function whose type says `Promise<T>`. Every rebound export changed shape: `listBatches(ctx)` threw
  // at the call site instead of returning a rejected promise, so `listBatches(ctx).catch(…)`, a
  // `Promise.all([...])` fan-out and `await expect(...).rejects` all stopped seeing it. The suite caught
  // it (test/module-gate.test.ts), and it is the exact class of breakage this change must not introduce:
  // a gate is allowed to refuse, never to change how a refusal ARRIVES. An async function body always
  // returns a rejected promise.
  return async function withGatedTenant<T>(ctx: SessionContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertModuleGate(ctx, code);
    return withTenant(ctx, fn);
  };
}

/** The four optional PACKS (packs/catalog.ts: `packBacked: true`, `isCore: false`). */
export const withAttendanceTenant = withModuleTenant('attendance');
export const withClaimsTenant = withModuleTenant('claims');
export const withPayrollTenant = withModuleTenant('payroll');
export const withPerformanceTenant = withModuleTenant('performance');
/** ADR-0095 — onboarding / offboarding / IT requisitions / assets. */
export const withLifecycleTenant = withModuleTenant('lifecycle');
