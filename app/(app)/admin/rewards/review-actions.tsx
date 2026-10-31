import Link from 'next/link';
import { Ban, CalendarClock, Eye, Pencil, Trash2 } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { deleteRewardAction } from '@/app/(app)/rewards/actions';
import { cancelRewardAction } from './actions';
import type { listRewardUnits } from '@/packs/rewards/service';
type Review = Awaited<ReturnType<typeof listRewardUnits>>[number];
const ROUTE = ['draft', 'bg', 'gr', 'ctro', 'ec', 'approved'];
/**
 * Each row offers only what its stage allows (62e743ed); the services remain the authority. Unused draft: View,
 * Edit, Delete. Draft in use or on the approval route: View, Edit (Group Rewards' draft settings) or Edit deadlines,
 * Cancel review. Posted, rejected or cancelled: View only.
 */
export async function RewardReviewActions({ review: r }: { review: Review }) {
    const t = await getTranslations('rewardsDeletion'), tc = await getTranslations('rewardsConfig'), locale = await getLocale();
    const live = ROUTE.includes(r.status), deletable = r.status === 'draft' && !r.deletionReason;
    const subtitle = `${r.cycle} · ${r.company} / ${r.unit}`;
    const day = (iso: string) => new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
    return <div className="space-y-1"><div className="flex flex-wrap items-center gap-1">
  <Button asChild variant="ghost" size="sm"><Link href={`/admin/rewards/${r.id}?mode=view`}><Eye aria-hidden className="size-4"/>{t('view')}</Link></Button>
  {live && (r.canConfigure
    ? <Button asChild variant="ghost" size="sm"><Link href={`/admin/rewards/${r.id}`}><Pencil aria-hidden className="size-4"/>{t('edit')}</Link></Button>
    : <Button asChild variant="ghost" size="sm"><Link href={`/admin/rewards/${r.id}#calendar`}><CalendarClock aria-hidden className="size-4"/>{tc('actions.editDeadlines')}</Link></Button>)}
  {deletable && <form action={deleteRewardAction}><input type="hidden" name="unitId" value={r.id}/><input type="hidden" name="revision" value={r.revision}/><input type="hidden" name="confirmation" value={r.id}/>
   <ConfirmSubmit variant="ghost" size="sm" className="text-destructive" title={t('confirmTitle')} subtitle={subtitle} description={t('confirmHelp')} confirmLabel={t('delete')} confirmVariant="destructive"><Trash2 aria-hidden className="size-4"/>{t('delete')}</ConfirmSubmit>
  </form>}
  {!deletable && r.canCancel && <form action={cancelRewardAction}><input type="hidden" name="unitId" value={r.id}/><input type="hidden" name="revision" value={r.revision}/>
   <ConfirmSubmit variant="ghost" size="sm" className="text-destructive" title={tc('actions.cancelTitle')} subtitle={subtitle} description={tc('actions.cancelHelp')} reasonField={{ name: 'reason', label: tc('actions.reason'), required: true }} confirmLabel={tc('actions.cancel')} cancelLabel={tc('actions.keep')} confirmVariant="destructive"><Ban aria-hidden className="size-4"/>{tc('actions.cancel')}</ConfirmSubmit>
  </form>}
 </div>{r.cancellation && <p className="max-w-xs text-xs text-muted-foreground">{r.cancellation.by ? tc('actions.cancelledBy', { date: day(r.cancellation.on), name: r.cancellation.by, reason: r.cancellation.reason }) : tc('actions.cancelledOn', { date: day(r.cancellation.on), reason: r.cancellation.reason })}</p>}</div>;
}
