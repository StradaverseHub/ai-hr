import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { delegationsScoped, eligibleDelegates, employmentPickerList, listCompanies, listDepartments, myEmployments } from '@/core/read';
import { listBusinessUnits } from '@/core/admin';
import { approverLevelOf, hasDownline } from '@/core/org';
import { todayInKualaLumpur } from '@/core/leave';
import { PageHeader } from '@/components/ui';
import { DelegationManager } from '@/components/delegation-manager';
import type { OrgScopeMasters } from '@/components/delegation-org-scope-picker';
import type { DelegationContext } from './actions';

/**
 * Global Delegation Management (Phase 1). A single screen listing who is covering approvals for whom, with
 * self-service (managers) and HR management (any employment, plus history). Server Component — it fetches
 * the initial context and renders the SHARED DelegationManager (popup parity, feedback 29fe2d45): the
 * command-bar popup renders the exact same component, so the full page is purely a larger workspace.
 * Save outcomes render inline from useActionState inside the manager (no ?error/?toast banners anymore);
 * ?history=1 is just the initial value of the manager's client-side history state, so old links keep
 * working. No sidebar entry (per the request).
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<{ history?: string }>;
}) {
  const { history: historyParam } = await searchParams;
  const t = await getTranslations('delegations');
  // scopedSession (not a bare getSession) is the page guard the access matrix records: every authenticated
  // role reaches /delegations; the DATA is scoped in the reads (HR sees the tenant, a self-service user only
  // their own rows). We don't filter the delegation list by company scope — a delegation is a person↔person
  // handover, not a company-scoped list.
  const { s } = await scopedSession();
  const admin = isAdmin(s);
  const today = todayInKualaLumpur();
  const history = admin && historyParam === '1';

  const [rows, pickerRaw, mine, companiesRaw, businessUnitsRaw, departmentsRaw] = await Promise.all([
    delegationsScoped(s, { isAdmin: admin, history, asOf: today }),
    admin ? employmentPickerList(s) : Promise.resolve([]),
    admin ? Promise.resolve([]) : myEmployments(s),
    // R51 (baf56348): coverage cascade masters (tenant-readable under RLS, so self-service works too).
    listCompanies(s),
    listBusinessUnits(s),
    listDepartments(s),
  ]);
  const myIds = new Set(mine.map((m) => m.employmentId));
  const masters: OrgScopeMasters = {
    companies: companiesRaw.map((c) => ({ id: c.id, name: c.name })),
    businessUnits: businessUnitsRaw.map((b) => ({ id: b.id, name: b.name, companyId: b.companyId })),
    departments: departmentsRaw.map((d) => ({
      id: d.id,
      name: d.name,
      companyId: d.companyId,
      businessUnitId: d.businessUnitId,
    })),
  };
  // Self-service create is offered to an APPROVER: a caller employment with a downline OR (R51) a
  // department/BU headship — a pure head with no administrative reports clearly holds approval duties.
  let selfDelegator: string | null = null;
  if (!admin) {
    for (const m of mine) {
      if (
        (await hasDownline(s, m.employmentId, today)) ||
        (await approverLevelOf(s, m.employmentId, today)) !== 'none'
      ) {
        selfDelegator = m.employmentId;
        break;
      }
    }
  }
  // R51: the "delegate to" list is RANK-aware — same-level candidates from the SECURITY-DEFINER eligible
  // list (siblings across the org the caller cannot see under plain RLS), computed at page render.
  const selfCandidates = selfDelegator ? await eligibleDelegates(s, selfDelegator) : [];

  const initialContext: DelegationContext = {
    admin,
    canSelfDelegate: selfDelegator != null,
    initialCandidates: selfCandidates.filter((c) => !myIds.has(c.employmentId)),
    delegatorOptions: pickerRaw,
    masters,
    rows,
    myEmploymentIds: mine.map((m) => m.employmentId),
    today,
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <DelegationManager surface="page" initialContext={initialContext} initialHistory={history} />
    </div>
  );
}
