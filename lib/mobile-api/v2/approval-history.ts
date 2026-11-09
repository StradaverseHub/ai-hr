import { z } from 'zod';
import { APPROVAL_HISTORY_MODULES } from '../../approval-history';
import { pageOf } from './common';

export const MobileApprovalHistoryAction = z.enum(['approved', 'rejected']);
export const MobileApprovalHistoryItem = z.object({
  id: z.guid(),
  moduleKey: z.enum(APPROVAL_HISTORY_MODULES),
  actionKey: z.enum(['approved', 'rejected', 'stepApproved', 'perDayDecision', 'confirmed', 'extended', 'terminated']),
  subjectName: z.string().nullable(),
  deciderName: z.string().nullable(),
  occurredAt: z.iso.datetime(),
});
export type MobileApprovalHistoryItem = z.infer<typeof MobileApprovalHistoryItem>;
export const MobileApprovalHistoryPage = pageOf(MobileApprovalHistoryItem);
