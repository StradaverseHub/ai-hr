/** Client twin of core/system-labels.ts. Origin is provenance; only Criteria grants availability. */
export type CompanyScopedLabel = { companyId: string; isGlobal: boolean; assignedCompanyIds: readonly string[] };
export function labelInCompanyScope(label: CompanyScopedLabel, companyIds: ReadonlySet<string>): boolean {
  return companyIds.size > 0 && (label.isGlobal || label.assignedCompanyIds.some(id => companyIds.has(id)));
}
export function labelsInCompanyScope<T extends CompanyScopedLabel>(labels: readonly T[], companyIds: ReadonlySet<string>): T[] {
  return labels.filter(label => labelInCompanyScope(label, companyIds));
}
