/**
 * r367 (073233bb) - "DID THIS LEAVE REQUEST ACTUALLY COST A BALANCE DAY?", asked in SQL, in one place.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * r362 shipped Leave History Data Import as RECORD-ONLY: an approved `leave_request` carrying no
 * `leave_ledger` debit. That was a shape this system had never had, and three money paths read
 * `leave_request` rather than the ledger, so all three were narrowed by the import MARKER
 * (`leave_request.imported_history = false`):
 *
 *   1. core/leave.ts `applyLeaveCancellationApprovalTx` - narrowed on the LEDGER (`chargedDays > 0`),
 *      not on the marker, and therefore already correct both before and after r367. It is named here
 *      only so the set of three is complete and nobody goes looking for a fourth.
 *   2. core/payroll.ts `unpaidDaysByEmployment` (and its multi-cycle copy) - excluded on the marker.
 *   3. core/leave-encashment.ts `approvedLeaveDaysAfter` - excluded on the marker.
 *
 * r367 makes an imported record CHARGED by default: the import now writes the matching ledger debit
 * unless the uploader states their opening balances are already net of the leave. The marker-based
 * exclusions therefore INVERT. Leaving them as they were would be a new defect in the opposite
 * direction: a charged imported unpaid-type record whose days were never deducted from pay, and a
 * final-pay hint that stays silent about days that really are sitting in the ledger.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * CHALLENGE, AND WHAT THIS PREDICATE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The approved plan says "gate on whether a sourced debit exists, not on the import marker". Taken at
 * its most literal - exclude EVERY approved request that carries no sourced debit - that would have
 * reached far past this item:
 *
 *   EVIDENCE. `finalizeLeaveApproval` writes a sourced debit for every request it approves, so in code
 *   there is no ordinary approved request without one. But that is a claim about the WRITER, not about
 *   the rows. A production database holds rows written by earlier code, by data fixes and by other
 *   importers, and this round is explicitly forbidden from reading production to find out how many.
 *   A pure ledger gate would silently stop deducting unpaid days for any such row - a salary moving
 *   because of a migration item, on rows nobody reported.
 *
 *   DECISION. The predicate is the CONJUNCTION: a row is excluded only when it is imported history AND
 *   carries no sourced debit. That is exactly the set r362 created and r367 changes, and it is empty for
 *   every row that is not an import. The import marker survives as the SCOPE of the exclusion; what no
 *   longer decides anything on its own is the marker, which is the defect the plan named.
 *
 *   CONFIDENCE high, and the difference is pinned: `test/leave-history-import-balance.test.ts` asserts
 *   that an ordinary approved unpaid request with no sourced ledger row IS still deducted. A future
 *   round that "simplifies" this to a pure ledger test fails that case rather than discovering it in a
 *   payslip.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS A DEBIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The EXISTENCE of a `debit` row sourced to the request, not the sign of its sum. A cancellation writes
 * a positive reversal row against the same `source_request_id` (core/leave.ts), so a net sum would call
 * a fully reversed request "never charged" - and it was charged, and then given back. These two paths
 * ask "were this request's days ever taken off a balance by this system", which existence answers and a
 * net sum does not. `core/leave.ts`'s own `wasCharged` asks a different question - "is there a charge
 * standing right now that a split must reverse" - and correctly uses the net sum; the two are not
 * duplicates and must not be merged.
 */
import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { leaveLedger, leaveRequest } from '../db/schema';

/**
 * TRUE for a `leave_request` row that carries at least one `leave_ledger` debit sourced to it.
 *
 * Correlated on `leave_request.id`, so it composes into any query that has `leave_request` in scope and
 * needs no join and no grouping change at the call site. NOT a join: the three call sites all GROUP or
 * SUM, and a join would multiply a request that carries a reversal beside its original debit.
 *
 * COST, stated rather than assumed: `leave_ledger.source_request_id` carries a foreign key and no index
 * of its own (db/schema.ts), so this is a scan of the tenant's ledger slice per candidate row. Every call
 * site is already narrowed hard first - one employment and one leave type, or one payroll period's
 * approved unpaid requests - so the candidate set is small. If a wider caller ever appears, index the
 * column rather than copying this predicate with a join.
 */
export function hasSourcedLedgerDebit(): SQL {
  return sql`exists (
    select 1 from ${leaveLedger}
    where ${leaveLedger.sourceRequestId} = ${leaveRequest.id}
      and ${leaveLedger.entryType} = 'debit'
  )`;
}

/**
 * THE MONEY-PATH EXCLUSION, as one predicate three call sites share.
 *
 * TRUE for a row a money path may count: anything that is not imported history, plus any imported
 * record whose days this system really did take off a balance. FALSE only for an UNCHARGED imported
 * record - r362's shape, which `openingBalancesAreNet = true` still produces on purpose.
 *
 * Read it as "these days have not already been settled outside this system".
 */
export function leaveDaysAreThisSystems(): SQL {
  return sql`(${eq(leaveRequest.importedHistory, false)} or ${hasSourcedLedgerDebit()})`;
}
