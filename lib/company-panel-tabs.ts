/**
 * 65b22c00 — the Organization company panel's three tabs, as ONE declaration.
 *
 * Three files have to agree on this vocabulary and none of them can import the others safely:
 *
 *   · components/company-panel.tsx is `'use client'` — a server module may not call a value exported
 *     from it (every export of a "use client" module is a client reference on the server).
 *   · app/admin/organization/[companyId]/page.tsx is a server component and has to VALIDATE the `?tab=`
 *     it reads off the URL before handing it back to the panel.
 *   · app/admin/actions.ts is `'use server'` — it may only export async functions, so a closed list
 *     cannot live there either, and it needs one because the tab goes into a redirect URL.
 *
 * So the list lives in a plain module, the way lib/personnel-tab-sections.ts does for the same reason.
 * A tab key reaching a redirect is checked against THIS array and nothing else: never the posted string,
 * which would be a query-injection hole at the one place a path and a query string are concatenated.
 */
export const COMPANY_PANEL_TABS = ['general', 'bank', 'statutory'] as const;

export type CompanyPanelTab = (typeof COMPANY_PANEL_TABS)[number];

export function isCompanyPanelTab(v: unknown): v is CompanyPanelTab {
  return typeof v === 'string' && (COMPANY_PANEL_TABS as readonly string[]).includes(v);
}
