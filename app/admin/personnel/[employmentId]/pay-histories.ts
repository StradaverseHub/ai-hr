import { withAccessDisplayRead } from '@/core/access-configuration-lock';
import { compensationAmendmentHistory, compensationHistoryDetailed } from '@/core/comp';
import { employmentPaymentMethodHistory } from '@/core/employment-payment-method';
import type { SessionContext } from '@/db/client';

export function readPersonnelPayHistories(session: SessionContext, employmentId: string, amendmentPage: number) {
  return withAccessDisplayRead(() => Promise.all([
    employmentPaymentMethodHistory(session, employmentId),
    compensationHistoryDetailed(session, employmentId),
    compensationAmendmentHistory(session, employmentId, amendmentPage),
  ]));
}
