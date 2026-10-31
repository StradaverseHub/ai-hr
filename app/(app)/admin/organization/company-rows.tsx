import Link from 'next/link';

/**
 * Organization → Companies: the LISTING row model (item defd4644).
 *
 * The redesign turned Organization from "one company form with a create form bolted on" into the
 * browse → pick → maintain shape every other admin module has. This module is the browse half's pure
 * core plus its table body, kept out of page.tsx for two reasons:
 *
 *  1. `selectCompanyRows` is arithmetic over arrays — no DB, no React — so search / status filter /
 *     sort can be unit-tested directly instead of through a rendered page.
 *  2. `CompanyRows` is a stable exported component identity, which is how the page-level tests reach
 *     the rows the server actually resolved (the same trick the old tests used on OrganizationList).
 *
 * ── PARENT COMPANY IS A COLUMN ON PURPOSE ─────────────────────────────────────────────────────────
 * `listCompanies` does NOT select parentCompanyId; the group hierarchy comes from the separate
 * `companyTree` read. A flat listing built only from listCompanies would look complete and silently
 * drop the group structure that decides who can see whose employees. `parentBy` is therefore a
 * REQUIRED argument, not an optional nicety — see the note on visibleTree in page.tsx.
 *
 * `parentName` resolves against the SCOPED company set: a parent the viewer cannot administer never
 * has its name disclosed here, it renders as no parent, exactly as the re-rooted tree draws it.
 */

/** The subset of a `listCompanies` row this listing reads. */
export type CompanyListInput = {
  id: string;
  name: string;
  /** The company's short code / abbreviation (company.company_label) — the reporter's "code" column. */
  companyLabel: string | null;
  registrationNo: string | null;
  archivedAt: Date | null;
};

export type CompanyRow = {
  id: string;
  code: string | null;
  name: string;
  registrationNo: string | null;
  parentId: string | null;
  parentName: string | null;
  archived: boolean;
};

/** Sort keys are a CLOSED set — an unknown `?sort=` falls back to name rather than throwing or
 *  silently ordering by something nobody asked for (the /admin/notice-board convention). */
export const COMPANY_SORT_KEYS = ['code', 'name', 'regNo', 'parent', 'status'] as const;
export type CompanySortKey = (typeof COMPANY_SORT_KEYS)[number];

export const COMPANY_STATUS_FILTERS = ['active', 'archived'] as const;
export type CompanyStatusFilter = (typeof COMPANY_STATUS_FILTERS)[number];

export function parseCompanySort(raw: string | undefined | null): CompanySortKey {
  return COMPANY_SORT_KEYS.includes(raw as CompanySortKey) ? (raw as CompanySortKey) : 'name';
}

/** null = no status filter (show both active and archived). */
export function parseCompanyStatus(raw: string | undefined | null): CompanyStatusFilter | null {
  return COMPANY_STATUS_FILTERS.includes(raw as CompanyStatusFilter)
    ? (raw as CompanyStatusFilter)
    : null;
}

const byText = (a: string | null, b: string | null) => (a ?? '').localeCompare(b ?? '');

/**
 * Resolve the visible rows from the ALREADY-SCOPED company list. This never widens anything: it takes
 * whatever `listCompanies(..., { adminOnly: true })` returned and only ever narrows it. The scope
 * boundary is the query's `app.is_admin_for`, not this function.
 */
export function selectCompanyRows(
  companies: readonly CompanyListInput[],
  parentBy: ReadonlyMap<string, string | null>,
  opts: { q?: string; status?: string; sort?: string } = {},
): CompanyRow[] {
  const nameById = new Map(companies.map((c) => [c.id, c.name]));
  const needle = (opts.q ?? '').trim().toLowerCase();
  const wanted = parseCompanyStatus(opts.status);
  const sort = parseCompanySort(opts.sort);

  const rows: CompanyRow[] = companies.map((c) => {
    const parentId = parentBy.get(c.id) ?? null;
    return {
      id: c.id,
      code: c.companyLabel,
      name: c.name,
      registrationNo: c.registrationNo,
      parentId,
      // A parent outside the administrable set is not named — `parentBy` already re-roots those to
      // null, and this second lookup means a future caller passing a raw tree still cannot leak one.
      parentName: parentId ? (nameById.get(parentId) ?? null) : null,
      archived: c.archivedAt != null,
    };
  });

  const matched = rows
    .filter((r) =>
      needle
        ? (r.code ?? '').toLowerCase().includes(needle) ||
          r.name.toLowerCase().includes(needle) ||
          (r.registrationNo ?? '').toLowerCase().includes(needle)
        : true,
    )
    .filter((r) => (wanted === null ? true : (wanted === 'archived') === r.archived));

  // Name is the tiebreaker on every key, so two companies sharing a code / status / parent still come
  // out in a stable, readable order rather than in whatever order the query happened to return.
  return matched.sort((a, b) => {
    switch (sort) {
      case 'code':
        return byText(a.code, b.code) || byText(a.name, b.name);
      case 'regNo':
        return byText(a.registrationNo, b.registrationNo) || byText(a.name, b.name);
      case 'parent':
        return byText(a.parentName, b.parentName) || byText(a.name, b.name);
      case 'status':
        return Number(a.archived) - Number(b.archived) || byText(a.name, b.name);
      default:
        return byText(a.name, b.name);
    }
  });
}

/**
 * The table body. Every row's name links to that company's own page — its read-only view since
 * 7a595a02; the redesign's whole point is that a company opens a page, not an accordion.
 *
 * ── THE ACTIONS COLUMN (item 3c2f55d7 rev 2) ──────────────────────────────────────────────────────
 * The single "Open" link became View · Edit · Archive, which is what the reporter asked for and what
 * every other admin listing in the product offers.
 *
 * ⚠️ 7a595a02 (r403) — View and Edit NO LONGER go to the same address. 3c2f55d7 rev 2 pointed both at
 * the editor because no read-only rendering existed, and said that if one were built "only the `view`
 * href changes". It was built: /admin/organization/[companyId]/view shows the company as text, with an
 * Edit button into the editor. View goes there, and so does the company's NAME — the reporter's plan
 * says opening a company must never land in a form, so entering edit mode is always a deliberate Edit.
 * Edit is unchanged. The view sits in the SAME permissions column and behind the same guard, so this is
 * not a new capability: whoever reaches the row can open both.
 *
 * Archive is a FORM, not a link: it is a write, and it posts to the same `archiveCompanyAction` the
 * company's own page uses. `archived` is posted as an explicit "true"/"false" string rather than by the
 * field's presence — a hidden input is submitted whatever its value, so a presence check would read
 * every row as "archive me" (AGENTS.md rule 17). An archived row offers Unarchive instead, so the
 * column is never a dead end.
 */
export function CompanyRows({
  rows,
  labels,
  archiveAction,
  basePath = '/admin/organization',
}: {
  rows: readonly CompanyRow[];
  labels: {
    active: string;
    archived: string;
    empty: string;
    view: string;
    edit: string;
    archive: string;
    unarchive: string;
  };
  /** The server action behind the Archive / Unarchive button. Bound by the page that owns the route. */
  archiveAction: (fd: FormData) => void | Promise<void>;
  basePath?: string;
}) {
  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
          {labels.empty}
        </td>
      </tr>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <tr key={r.id} className={r.archived ? 'opacity-60 hover:bg-muted/40' : 'hover:bg-muted/40'}>
          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.code ?? '—'}</td>
          <td className="px-3 py-2">
            <Link href={`${basePath}/${r.id}/view`} className="font-medium text-foreground hover:text-primary">
              {r.name}
            </Link>
          </td>
          <td className="px-3 py-2 text-muted-foreground">{r.registrationNo ?? '—'}</td>
          <td className="px-3 py-2 text-muted-foreground">{r.parentName ?? '—'}</td>
          <td className="px-3 py-2">
            <span
              className={
                r.archived
                  // 3783fd87 — the Archived chip is LINED, not filled grey, to match the rest of the
                  // module. The Active chip keeps its emerald wash: that one carries meaning, and the
                  // request was to remove grey, not colour.
                  ? 'inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground'
                  : 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
              }
            >
              {r.archived ? labels.archived : labels.active}
            </span>
          </td>
          <td className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Link href={`${basePath}/${r.id}/view`} className="text-primary underline underline-offset-2">
                {labels.view}
              </Link>
              <span aria-hidden className="text-border">
                |
              </span>
              <Link href={`${basePath}/${r.id}`} className="text-primary underline underline-offset-2">
                {labels.edit}
              </Link>
              <span aria-hidden className="text-border">
                |
              </span>
              <form action={archiveAction} className="inline">
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="archived" value={r.archived ? 'false' : 'true'} />
                <button type="submit" className="text-primary underline underline-offset-2">
                  {r.archived ? labels.unarchive : labels.archive}
                </button>
              </form>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
