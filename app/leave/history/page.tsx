import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { myEmployment, listLeaveTypes, listEligibleLeaveTypesFor } from '@/core/read';
import { Card, PageHeader } from '@/components/ui';
import { loadOwnLeaveHistory, type HistorySearch } from '@/components/leave/own-leave-history';

export default async function LeaveHistoryPage({ searchParams }: { searchParams: Promise<HistorySearch & { error?: string; toast?: string }> }) {
  const { s: session } = await scopedSession();
  const me = await myEmployment(session);
  const t = await getTranslations('leave');
  const tMe = await getTranslations('me');
  if (!me || isAdmin(session)) return <Card className="p-8 text-center"><h1>{t('historyHeading')}</h1><p>{!me ? tMe('notLinked') : t('inquiryMovedToTracker')}</p></Card>;
  const locale = await getLocale();
  const sp = await searchParams;
  const [leaveTypes, eligible] = await Promise.all([listLeaveTypes(session, {locale, includeArchived:false}), listEligibleLeaveTypesFor(session, me.employmentId, locale)]);
  const { history } = await loadOwnLeaveHistory({session, me, sp, locale, leaveTypes, eligibleTypeIds:new Set(eligible.map((row) => row.id))});
  return <div className="w-full min-w-0 space-y-6"><PageHeader title={t('historyHeading')} />{sp.error && <p className="text-sm text-destructive">{sp.error}</p>}{history}</div>;
}
