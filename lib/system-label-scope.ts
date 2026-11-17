/** Client twin of core/system-labels.ts. Origin is provenance; only Criteria grants availability. */
export type CompanyScopedLabel = { companyId: string; isGlobal: boolean; assignedCompanyIds: readonly string[] };
export function labelInCompanyScope(label: CompanyScopedLabel, companyIds: ReadonlySet<string>): boolean {
  return companyIds.size > 0 && (label.isGlobal || label.assignedCompanyIds.some(id => companyIds.has(id)));
}
export function labelsInCompanyScope<T extends CompanyScopedLabel>(labels: readonly T[], companyIds: ReadonlySet<string>): T[] {
  return labels.filter(label => labelInCompanyScope(label, companyIds));
}

/** Picker metadata for already authorized catalogue rows and company choices.
 * Uses the same Criteria predicate as destination filtering, never origin ownership. */
export function labelCompanyCsv(labels:readonly (CompanyScopedLabel & {id:string})[],companyIds:readonly string[]):Map<string,string>{
  const companies=[...new Set(companyIds)].sort().map(id=>({id,scope:new Set([id])}));
  return new Map(labels.flatMap(label=>{
    const available=companies.filter(company=>labelInCompanyScope(label,company.scope)).map(company=>company.id);
    return available.length?[[label.id,available.join(',')] as const]:[];
  }));
}
