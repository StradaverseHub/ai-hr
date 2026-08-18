/**
 * 6df24751 — the Pay Schedule route map, in one place.
 *
 * Pay Schedule is the one screen of the three where a company really does hold a SINGLE set of settings,
 * so it is the one that goes company listing → that company's settings → edit, exactly as sketched.
 *
 * Every hop carries the listing's search term (`q`) forward — the plan promises the search survives the
 * round trip, and a back link that dropped it would land the admin on an unfiltered list.
 *
 * Plain TS, no i18n and no server imports: the server action imports it for its redirect targets and the
 * pages import it for their links, so the two cannot disagree about where a screen lives.
 */
export const CONFIG_ROOT = '/admin/payroll-config';

const withQ = (href: string, q?: string) => {
  const term = (q ?? '').trim();
  if (!term) return href;
  return `${href}${href.includes('?') ? '&' : '?'}q=${encodeURIComponent(term)}`;
};

/** The company listing (step 1). */
export const configListHref = (q?: string) => withQ(CONFIG_ROOT, q);

/** One company's pay schedule, read-only (step 2). */
export const configCompanyHref = (companyId: string, q?: string) =>
  withQ(`${CONFIG_ROOT}/${encodeURIComponent(companyId)}`, q);

/** The edit form for one company's pay schedule (step 3). */
export const configEditHref = (companyId: string, q?: string) =>
  withQ(`${CONFIG_ROOT}/${encodeURIComponent(companyId)}/edit`, q);
