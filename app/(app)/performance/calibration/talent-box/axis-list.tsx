import { getTranslations } from 'next-intl/server';

export type TalentAxisRow={id:string;name:string;unit:string;department:string;grade:string;band:string|null};

/**
 * DQ-8 — the BG CEO's Performance and Potential tabs: the BG session's people on one axis, read only. Nothing here
 * writes; moves and the lock stay on the Talent box, through the existing actions.
 */
export async function TalentAxisList({scope,axis,rows}:{scope:string;axis:'performance'|'potential';rows:TalentAxisRow[]}){
 const t=await getTranslations('onehr');
 const title=t(`talentBoard.tabs.${axis}`),sorted=[...rows].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
 return <section data-talent-axis-list={axis} className="min-w-0 space-y-3">
  <header className="space-y-1">
   <p className="text-[0.78rem] font-semibold text-muted-foreground">{t('talentBoard.breadcrumb',{tier:'bg'})}</p>
   <h2 className="text-2xl font-bold leading-tight tracking-[-0.02em] text-primary">{scope}</h2>
   <p className="text-xs text-muted-foreground">{t('talentBoard.axisListHelp',{axis})}</p>
  </header>
  {sorted.length?<div role="region" aria-label={title} tabIndex={0} className="overflow-x-auto rounded-lg border border-border bg-card">
   <table className="w-full min-w-[36rem] text-sm"><caption className="sr-only">{title}</caption>
    <thead className="bg-muted/30 text-left text-xs text-muted-foreground"><tr><th scope="col" className="p-2">{t('talentList.columns.name')}</th><th scope="col" className="p-2">{t('talentBoard.businessUnit')}</th><th scope="col" className="p-2">{t('talentList.columns.department')}</th><th scope="col" className="p-2">{t('talentBoard.grade')}</th><th scope="col" className="p-2">{t(axis)}</th></tr></thead>
    <tbody>{sorted.map(r=><tr key={r.id} className="border-t border-border"><th scope="row" className="p-2 text-left font-medium">{r.name}</th><td className="p-2">{r.unit||'—'}</td><td className="p-2">{r.department||'—'}</td><td className="p-2 tabular-nums">{r.grade||'—'}</td><td translate="no" className="p-2">{r.band??'—'}</td></tr>)}</tbody>
   </table>
  </div>:<p className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">{t('talentBoard.axisListEmpty')}</p>}
 </section>;
}
