import { organisationChoiceLabels } from '@/lib/organisation-choice-label';
import { isAdmin } from '@/lib/authz';
import { delegationsScoped, eligibleDelegates, employmentPickerList, listCompanies, listDepartments, myEmployments } from '@/core/read';
import { listBusinessUnits } from '@/core/admin';
import { approverLevelOf, hasDownline } from '@/core/org';
import { todayInKualaLumpur } from '@/core/leave';
import type { OrgScopeMasters } from '@/components/delegation-org-scope-picker';
import type { DelegationContext } from './actions';
import { withSharedReadSnapshot, type SessionContext } from '@/db/client';

/** The list and its form choices use one read-only view of the signed-in scope. */
export function readDelegationPageContext(s: SessionContext, includeHistory: boolean) {
  return withSharedReadSnapshot(s, async () => {
    const admin = isAdmin(s);
    const today = todayInKualaLumpur();
    const history = admin && includeHistory;

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
      // f1bbc572 — the Criteria fields travel with the masters so the picker can apply the resolver's own
      // origin ∪ global rule (flag-gated, exactly as labelUsableByCompany does at save time).
      companies: companiesRaw.map((c) => ({ id: c.id, name: c.name })),
      businessUnits: organisationChoiceLabels(businessUnitsRaw).map((b) => ({ id: b.id, name: b.displayLabel, companyId: b.companyId, isGlobal: b.isGlobal, assignedCompanyIds: b.assignedCompanyIds })),
      departments: organisationChoiceLabels(departmentsRaw).map((d) => ({
        id: d.id,
        name: d.displayLabel,
        companyId: d.companyId,
        businessUnitId: d.businessUnitId,
        isGlobal: d.isGlobal, assignedCompanyIds: d.assignedCompanyIds,
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
    return { initialContext, history };
  });
}
