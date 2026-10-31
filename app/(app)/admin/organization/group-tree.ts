/**
 * The group hierarchy, intersected with what the signed-in person may administer (item defd4644).
 *
 * WHY THIS IS A SEPARATE READ AND MUST STAY ONE. `listCompanies` does not select parentCompanyId;
 * `companyTree` does. The parent relationship is what several other screens use to decide who can see
 * whose employees, so a listing built from `listCompanies` alone looks complete while the hierarchy
 * quietly stops being visible or editable. Both the listing (parent column, group-structure card) and
 * the maintenance page (parent picker) resolve it through here so they cannot disagree.
 *
 * Two things happen below and both are deliberate:
 *   • the FILTER, so a company-scoped admin is not shown a group they cannot administer; and
 *   • the RE-ROOTING, which is the part that would otherwise be a silent hole. CompanyTree descends
 *     from `parentId === null` only, so a subsidiary whose parent is out of reach would keep a parent
 *     id that is not in `nodes`, match no branch, and render NOWHERE — while still being counted.
 *     Nulling the dangling link makes it a root of the visible group instead.
 *
 * For a group-wide admin `visibleIds` holds every company, so both steps are identities.
 */

export type TreeNode = { id: string; name: string; country: string; parentId: string | null };

export function resolveGroupTree(
  companies: readonly { id: string }[],
  tree: readonly TreeNode[],
): { visibleTree: TreeNode[]; parentBy: Map<string, string | null> } {
  const visibleIds = new Set(companies.map((c) => c.id));
  const visibleTree = tree
    .filter((n) => visibleIds.has(n.id))
    .map((n) => ({ ...n, parentId: n.parentId && visibleIds.has(n.parentId) ? n.parentId : null }));
  return { visibleTree, parentBy: new Map(visibleTree.map((n) => [n.id, n.parentId])) };
}
