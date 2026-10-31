import { getFormatter, getTranslations } from 'next-intl/server';
import type { agentBuildList } from '@/core/agent-build-list';
import { Card, SectionHeader, btnGhost } from '@/components/ui';

/** Complete export; bounded, explicitly paginated display. No capability can execute from this view. */
export async function RankedBuildList({view,page=1}:{view:Awaited<ReturnType<typeof agentBuildList>>;page?:number}) {
  const t=await getTranslations('processAssessment.buildList');
  const process=await getTranslations('processAssessment');
  const f=await getFormatter();
  const pageSize=50,pages=Math.max(1,Math.ceil(view.entries.length/pageSize));
  const current=Math.min(pages,Math.max(1,Math.trunc(page)||1)),start=(current-1)*pageSize;
  const rows=view.entries.slice(start,start+pageSize);
  const href=(n:number)=>`/control-tower/opportunities?days=${view.window}&backlogPage=${n}#ranked-build-list`;
  const number=(n:number|null)=>n===null?'—':f.number(n,{maximumFractionDigits:1});
  return <Card id="ranked-build-list" className="overflow-hidden">
    <div className="space-y-3 p-5">
      <SectionHeader title={t('title')} subtitle={t('subtitle')}/>
      <p className="max-w-4xl text-sm text-muted-foreground">{t('proxy')}</p>
      <a className={btnGhost} href={`/control-tower/opportunities/backlog?days=${view.window}`}>{t('export')}</a>
    </div>
    <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm">
      <caption className="sr-only">{t('title')}</caption>
      <thead className="border-y border-border bg-muted/40"><tr>{['rank','entry','tier','process','staff','people'].map(key=><th key={key} scope="col" className="px-3 py-3">{t(key)}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">{rows.map(row=><tr key={row.id}>
        <td className="px-3 py-3 tabular-nums">{row.rank}</td>
        <td className="max-w-xs px-3 py-3"><code className="break-all text-xs">{row.entry}</code><p className="mt-1 break-all text-xs text-muted-foreground">{row.source}</p></td>
        <td className="px-3 py-3">{process(`tiers.${row.tier}`)}</td>
        <td className="max-w-xs px-3 py-3">{row.basis?process(`processes.${row.basis}`):row.processes.length?row.processes.map(id=>process(`processes.${id}`)).join(' · '):'—'}<p className="mt-1 text-xs text-muted-foreground">{t(row.measurement)}</p></td>
        <td className="px-3 py-3 tabular-nums">{number(row.staffActionsPer30)}</td>
        <td className="px-3 py-3 tabular-nums">{number(row.peopleAffected)}</td>
      </tr>)}</tbody>
    </table></div>
    {!rows.length&&<p className="p-5 text-sm text-muted-foreground">{t('none')}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-5 text-sm">
      <p>{t('showing',{from:rows.length?start+1:0,to:start+rows.length,total:view.entries.length})}</p>
      <nav aria-label={t('title')} className="flex gap-3">{current>1&&<a className={btnGhost} href={href(current-1)}>{t('previous')}</a>}{current<pages&&<a className={btnGhost} href={href(current+1)}>{t('next')}</a>}</nav>
    </div>
    <p className="px-5 pb-4 text-xs text-muted-foreground">{view.version} · {view.assessmentVersion}</p>
  </Card>;
}
