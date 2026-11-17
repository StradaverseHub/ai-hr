import { getTranslations } from 'next-intl/server';
import { btnGhost } from '@/components/ui';
import { cn } from '@/lib/utils';
import { addCandidateToPoolAction } from './actions';
import { selectCls } from './shared';

type T = Awaited<ReturnType<typeof getTranslations<'recruitment.pools'>>>;

/** "Add to pool" (slice 13): a candidate the viewer operates, into one of the pools the viewer can see. */
export function AddToPool({ candidateId, choices, here, t, id }: { candidateId: string; choices: { id: string; label: string }[]; here: string; t: T; id: string }) {
  return (
    <form action={addCandidateToPoolAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="returnTo" value={here} />
      <label className="sr-only" htmlFor={`pool-${id}`}>{t('add.label')}</label>
      <select id={`pool-${id}`} name="poolId" required defaultValue="" className={cn(selectCls, 'h-9 w-56')}>
        <option value="" disabled>{t('add.choose')}</option>
        {choices.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <button type="submit" className={btnGhost}>{t('add.submit')}</button>
    </form>
  );
}

