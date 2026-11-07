'use client';

import {useTranslations} from 'next-intl';
import {ENTITLEMENT_STATUS_LABEL_KEY,type EntitlementStatus} from '@/lib/entitlement-status';

/** Display the same status vocabulary as My Leave; never derive a status from a zero. */
export function EntitlementStatusLabel({status}:{status:EntitlementStatus}) {
  const t=useTranslations('me.leaveBalanceTable');
  return <span className="mt-1 block text-xs text-muted-foreground">{t(ENTITLEMENT_STATUS_LABEL_KEY[status])}</span>;
}
