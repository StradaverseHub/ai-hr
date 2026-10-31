/**
 * WP-B2 — the Leaders screen's view model. Client-safe (no server imports): the page maps the service rows
 * into these shapes, and the pure helpers below group them for the HOD and unit views.
 */
export type LeaderSeatKind = 'bu_ceo' | 'bg_ceo' | 'group_chief';
export type LeadersPerson = { employmentId: string; name: string | null; employeeCode: string | null; companyId: string; departmentId: string | null; departmentName: string | null };
export type LeadersCompany = { id: string; name: string; parentCompanyId: string | null; isGroupNode: boolean; canWriteBuCeo: boolean; canWriteBgCeo: boolean };
export type LeadersHod = { subjectEmploymentId: string; hodEmploymentId: string; hodName: string | null };
export type LeadersSeat = { id: string; seatType: LeaderSeatKind; companyId: string | null; calibrationGroupId: string | null; holderEmploymentId: string; holderName: string | null; holderEmployeeCode: string | null };
export type LeadersGroup = { id: string; name: string; members: number; chief: { seatId: string; employmentId: string; name: string | null } | null };
export type LeadersData = {
  people: LeadersPerson[]; companies: LeadersCompany[]; hods: LeadersHod[]; seats: LeadersSeat[]; groups: LeadersGroup[];
  canWriteHod: boolean; canWriteGroupChief: boolean;
};

export type HodPreviewView = {
  rows: { subjectEmploymentId: string; subjectName: string | null; subjectEmployeeCode: string | null; companyName: string | null; departmentName: string | null; currentHodName: string | null; nextHodName: string | null }[];
  unchanged: number; selfExcluded: number;
  blockers: { code: string; employmentIds: string[] }[];
  warnings: { code: string; employmentIds: string[] }[];
  fingerprint: string;
};
export type GroupMemberView = { id: string; employmentId: string; name: string | null; employeeCode: string | null };
export type ActionResult<T = null> = { ok: true; data: T } | { error: string };
export type GeneratedScopesView = { created: number; extended: number; added: number; skipped: number; people: number };

/** A company filter matches the company itself and the units below it. */
export function inCompany(filter: string, companyId: string | null, companies: readonly LeadersCompany[]): boolean {
  if (!filter) return true;
  if (!companyId) return false;
  return companyId === filter || companies.find((c) => c.id === companyId)?.parentCompanyId === filter;
}

/** One card per current HOD: the people they head, in roster order. */
export function hodCards(data: LeadersData, filter: string) {
  const personOf = new Map(data.people.map((p) => [p.employmentId, p]));
  const by = new Map<string, { hodEmploymentId: string; name: string | null; employeeCode: string | null; people: string[] }>();
  for (const h of data.hods) {
    const subject = personOf.get(h.subjectEmploymentId);
    if (filter && !inCompany(filter, subject?.companyId ?? null, data.companies)) continue;
    const card = by.get(h.hodEmploymentId) ?? { hodEmploymentId: h.hodEmploymentId, name: h.hodName, employeeCode: personOf.get(h.hodEmploymentId)?.employeeCode ?? null, people: [] };
    card.people.push(h.subjectEmploymentId);
    by.set(h.hodEmploymentId, card);
  }
  return [...by.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.hodEmploymentId.localeCompare(b.hodEmploymentId));
}

/** One row per department within a company: its people and who heads them now (one HOD, several, or none). */
export function departmentRows(data: LeadersData, filter: string) {
  const hodOf = new Map(data.hods.map((h) => [h.subjectEmploymentId, h]));
  const companyName = new Map(data.companies.map((c) => [c.id, c.name]));
  const by = new Map<string, { key: string; departmentName: string | null; companyId: string; companyName: string; people: string[]; hods: Map<string, string | null>; withoutHod: number }>();
  for (const p of data.people) {
    if (!inCompany(filter, p.companyId, data.companies)) continue;
    const key = `${p.departmentId ?? 'none'}:${p.companyId}`;
    const row = by.get(key) ?? { key, departmentName: p.departmentName, companyId: p.companyId, companyName: companyName.get(p.companyId) ?? '', people: [], hods: new Map<string, string | null>(), withoutHod: 0 };
    row.people.push(p.employmentId);
    const h = hodOf.get(p.employmentId);
    if (h) row.hods.set(h.hodEmploymentId, h.hodName); else row.withoutHod++;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => a.companyName.localeCompare(b.companyName) || (a.departmentName ?? '￿').localeCompare(b.departmentName ?? '￿'));
}
