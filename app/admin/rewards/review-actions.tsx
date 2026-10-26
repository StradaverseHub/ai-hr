import Link from 'next/link';
import { Eye, Pencil, Trash2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { deleteRewardAction } from '@/app/rewards/actions';
import type { listRewardUnits } from '@/packs/rewards/service';
export async function RewardReviewActions({ review: r }: {
    review: Awaited<ReturnType<typeof listRewardUnits>>[number];
}) {
    const t = await getTranslations('rewardsDeletion');
    return <div className="space-y-1"><div className="flex flex-wrap items-center gap-1">
  <Button asChild variant="ghost" size="sm"><Link href={`/admin/rewards/${r.id}?mode=view`}><Eye aria-hidden className="size-4"/>{t('view')}</Link></Button>
  {r.canConfigure ? <Button asChild variant="ghost" size="sm"><Link href={`/admin/rewards/${r.id}`}><Pencil aria-hidden className="size-4"/>{t('edit')}</Link></Button> : <Button disabled variant="ghost" size="sm"><Pencil aria-hidden className="size-4"/>{t('edit')}</Button>}
  <form action={deleteRewardAction}><input type="hidden" name="unitId" value={r.id}/><input type="hidden" name="revision" value={r.revision}/><input type="hidden" name="confirmation" value={r.id}/>
   <ConfirmSubmit disabled={!!r.deletionReason} variant="ghost" size="sm" className="text-destructive" title={t('confirmTitle')} subtitle={`${r.cycle} · ${r.company} / ${r.unit}`} description={t('confirmHelp')} confirmLabel={t('delete')} confirmVariant="destructive"><Trash2 aria-hidden className="size-4"/>{t('delete')}</ConfirmSubmit>
  </form>
 </div>{r.deletionReason && <p className="max-w-xs text-xs text-muted-foreground">{t(`reasons.${r.deletionReason}`)}</p>}{!r.canConfigure && r.status === 'draft' && <p className="max-w-xs text-xs text-muted-foreground">{t('editPermission')}</p>}</div>;
}
