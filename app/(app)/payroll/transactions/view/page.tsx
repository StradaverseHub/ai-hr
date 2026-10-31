import { redirect } from 'next/navigation';

/**
 * 59178702 — Transaction View relocation. The read-only Transaction View was promoted from a
 * Transactions sub-page to its own top-level Payroll tab at `/payroll/transaction-view`. This route
 * now permanently redirects there so bookmarked links (incl. `?tab=` sub-tab selection) still
 * resolve. The moved page carries the same access control it always had — no logic moved, only where
 * it renders — so this thin forwarder intentionally has no guard of its own.
 */
export default async function TransactionViewRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const qs = new URLSearchParams(await searchParams).toString();
  redirect(`/payroll/transaction-view${qs ? `?${qs}` : ''}`);
}
