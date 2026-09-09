/**
 * f1bbc572 — ONE definition of "which System Labels may this company use", for every surface that
 * narrows an already-loaded label catalogue to a company chosen at runtime.
 *
 * A System Label (department / position / cost centre / business unit) carries an ORIGIN company — the
 * company it happened to be added from — and an `is_global` flag, which is the Criteria the admin sets to
 * "Global / All Companies". Origin is NOT scope: a global label belongs to every company of the tenant,
 * whichever one created it. Screens that re-filtered a loaded catalogue on `company_id` alone therefore
 * hid global labels from every company but their origin — on the live tenant, 59 global labels created
 * under six of twelve companies, so no company saw the whole global set.
 *
 * This is the CLIENT-SIDE / IN-MEMORY twin of the server-side resolver in core/system-labels.ts
 * (`visibleLabelIdsCondition`, origin ∪ shared-in ∪ global). It deliberately does NOT model the
 * shared-in (junction) branch: a junction row is not carried on a label row, so a surface that needs it
 * must filter in SQL through the resolver instead of here. `globalUsable` mirrors the resolver's
 * `shared_system_labels` gate — `is_global = true AND exists (… co2.shared_system_labels = true)` — and
 * EVERY caller passes it, including pure list filters. Round 2 of f1bbc572: a surface that admits a
 * global label the resolver would refuse for that company is "visible in the maintenance list and
 * unavailable in the picker", which is worse than the defect this module was written to fix. The flag is
 * ON tenant-wide today (0298 + autoEnableSharedLabels), so passing it changes nothing until an admin
 * opts a company out — which is the moment it has to be right.
 *
 * Pure and dependency-free (the lib/hire-form-filter.ts precedent) so a server component, a client
 * component and a test all read the same rule.
 */

/** The two fields the rule needs from a label row. */
export type CompanyScopedLabel = { companyId: string; isGlobal: boolean };

/** True when `label` is usable by at least one company in `companyIds`: origin ∪ (global, if usable).
 *  `globalUsable` has NO DEFAULT on purpose — round 2 of f1bbc572 found the maintenance screen and the
 *  server resolver disagreeing precisely because a caller had inherited `true` without deciding. */
export function labelInCompanyScope(
  label: CompanyScopedLabel,
  companyIds: ReadonlySet<string>,
  globalUsable: boolean,
): boolean {
  if (companyIds.has(label.companyId)) return true;
  return label.isGlobal && globalUsable;
}

/** `labelInCompanyScope` over a list, preserving order and the row type. */
export function labelsInCompanyScope<T extends CompanyScopedLabel>(
  labels: readonly T[],
  companyIds: ReadonlySet<string>,
  globalUsable: boolean,
): T[] {
  return labels.filter((l) => labelInCompanyScope(l, companyIds, globalUsable));
}
