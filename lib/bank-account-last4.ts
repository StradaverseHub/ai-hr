/**
 * 48652e18 (r419) — the last four characters of a company bank account number, for the two places that
 * name an account WITHOUT printing it: the Remove confirmation on Admin › Organisation › Bank Account, and
 * the message shown after the removal (which travels in the URL as `?toast=`).
 *
 * Separators are dropped first, so `5140-1234-5678` ends `5678` rather than `-5678`.
 *
 * Returns `null` when the number has four characters or fewer: then "the last four" IS the whole number,
 * and the approved plan is that the dialog never shows the full number. Callers fall back to naming the
 * account and its bank without digits.
 *
 * This is NOT a mask for the account heading on the same screen — that line prints the company's own
 * debit account in full on purpose (3c2f55d7 rev 2; test/company-panel-bank-statutory-layout.test.ts).
 */
export function accountLast4(accountNo: string | null | undefined): string | null {
  const compact = String(accountNo ?? '').replace(/[^0-9A-Za-z]/g, '');
  return compact.length > 4 ? compact.slice(-4) : null;
}
