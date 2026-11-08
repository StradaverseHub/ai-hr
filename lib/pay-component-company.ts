/** NULL is the legacy All Companies setting; an explicit list is never empty. */
export function payComponentAppliesToCompany(item: { appliedCompanyIds?: readonly string[] | null }, companyId: string): boolean {
  return item.appliedCompanyIds == null || item.appliedCompanyIds.includes(companyId);
}

export function normalizePayComponentCompanies(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 10000 ||
      value.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('Select at least one valid company for this Pay Item.');
  }
  return [...new Set(value.map(id => id.toLowerCase()))].sort();
}
