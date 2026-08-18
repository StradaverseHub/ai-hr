/**
 * 6df24751 — the Payroll Cycles route map, in one place.
 *
 * The screen is company-first now: a company listing, then that company's cycle catalog, then one cycle.
 * Every hop must carry the LISTING's search term (`q`) forward, because the approved plan promises "your
 * search on the listing is still there when you return" — a back link that dropped it would send the
 * admin back to an unfiltered list of every company they manage.
 *
 * Plain TS, no i18n and no server imports: server actions import it for their redirect targets and the
 * pages import it for their links, so the two can never disagree about where a screen lives.
 */
export const CYCLE_ROOT = '/admin/payroll-cycle';

/** `?q=` only when there is something to carry — a bare `?q=` in every href is noise in the address bar. */
const withQ = (href: string, q?: string) => {
  const term = (q ?? '').trim();
  if (!term) return href;
  return `${href}${href.includes('?') ? '&' : '?'}q=${encodeURIComponent(term)}`;
};

/** The company listing (step 1). */
export const cycleListHref = (q?: string) => withQ(CYCLE_ROOT, q);

/** One company's cycle catalog (step 2). */
export const cycleCompanyHref = (companyId: string, q?: string) =>
  withQ(`${CYCLE_ROOT}/${encodeURIComponent(companyId)}`, q);

/** The Add New Cycle screen for one company (step 3a). */
export const cycleNewHref = (companyId: string, q?: string) =>
  withQ(`${CYCLE_ROOT}/${encodeURIComponent(companyId)}/new`, q);

/** One cycle's own view + edit screen (step 3b). */
export const cycleHref = (companyId: string, cycleId: string, q?: string) =>
  withQ(`${CYCLE_ROOT}/${encodeURIComponent(companyId)}/${encodeURIComponent(cycleId)}`, q);
