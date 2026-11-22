import { withSharedReadSnapshot, type SessionContext } from '@/db/client';
import { currencyOfEmployment } from '@/core/mobile-claims';
import { claimRecordFacts, getEmployeeClaimTypes, listClaimDraftsForEmployment, listClaimHistoryPage } from '@/packs/claims/service';

export function readClaimsPageData(session: SessionContext, employmentId: string, query: {page?: string; size?: string}) {
  // These reads supply the employee's page. Keep their foreground snapshot independent of passive shell work.
  return withSharedReadSnapshot(session, async () => {
    const [types, drafts, {rows: claimPage, state: pgState}, currency] = await Promise.all([
      getEmployeeClaimTypes(session, employmentId),
      listClaimDraftsForEmployment(session, employmentId),
      listClaimHistoryPage(session, employmentId, query),
      currencyOfEmployment(session, employmentId).catch(() => null),
    ]);
    // Only displayed rejections need detail facts.
    const rejectReasons = await claimRecordFacts(session, claimPage.filter(claim => claim.status === 'rejected').map(claim => claim.id));
    return {types, drafts, claimPage, pgState, currency, rejectReasons};
  });
}
