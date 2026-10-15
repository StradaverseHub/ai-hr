import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {getAssessmentOverview} from '@/packs/performance/service';
import type {OverviewCell,OverviewModule} from '@/packs/performance/onehr/overview-model';
import {Card} from '@/components/ui';
export async function PerformanceOverview({session}:{session:SessionContext}){
 const [{overview:o,readiness},t,ta]=await Promise.all([getAssessmentOverview(session),getTranslations('onehr.overview'),getTranslations('onehr.adminAssistant')]);
 const word=(k:OverviewModule)=>t('words.'+(k==='pm'&&o?.kind==='quarterly'?'checkins':k));
 function cell(c:OverviewCell,k:OverviewModule){
  const body=<><span className="block text-lg font-semibold tabular-nums">{c.pct===null?'—':c.pct+'%'}</span><span className="block text-xs text-muted-foreground">{c.state==='not_open'&&!c.done?c.opens?t('opens',{date:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium'}).format(new Date(c.opens))}):t('notOpen'):!c.total?t('none'):t('doneOf',{done:c.done,total:c.total,word:word(k)})}</span>{c.pct!==null&&<span className="mt-2 block h-1 overflow-hidden rounded bg-muted"><span className="block h-full bg-primary" style={{width:c.pct+'%'}}/></span>}</>;
  return c.href?<Link href={c.href} className="block min-w-36 rounded-md p-2 hover:bg-muted">{body}</Link>:<span className="block min-w-36 p-2">{body}</span>;
 }
 const needs=readiness.steps.filter(s=>!s.done);
 return <section className="min-w-0 space-y-4" aria-label={t('title')}>
  <div><h2 className="text-xl font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{o?o.cycle.name:t('notRunning')}</p></div>
  {o&&o.modules.length>0&&o.rows.length>0&&<Card className="max-w-full overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/30"><tr><th scope="col" className="p-3">{t('group')}</th><th scope="col" className="p-3">{t('people')}</th>{o.modules.map(k=><th scope="col" key={k} className="p-3">{t('modules.'+k)}</th>)}</tr></thead><tbody className="divide-y divide-border">{o.rows.map(r=><tr key={r.id}><th scope="row" className="whitespace-nowrap p-3 font-medium">{r.name}</th><td className="p-3 tabular-nums">{r.people}</td>{o.modules.map(k=><td key={k} className="p-2">{cell(r.cells[k],k)}</td>)}</tr>)}{o.rows.length>1&&<tr className="bg-muted/20"><th scope="row" className="p-3">{t('all')}</th><td className="p-3">{o.totals.people}</td>{o.modules.map(k=><td key={k} className="p-2">{cell(o.totals.cells[k],k)}</td>)}</tr>}</tbody></table></div></Card>}
  <div className="grid min-w-0 gap-4 lg:grid-cols-2">
   <Card className="space-y-3 p-5"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{t('needs')}</h3><span className="text-xs text-muted-foreground">{t('steps',{done:readiness.done,total:readiness.total})}</span></div>{needs.length?<ul className="divide-y divide-border">{needs.map(s=><li key={s.module+'.'+s.label} className="py-3 text-sm"><Link href={s.href} className="font-medium text-primary hover:underline">{s.label} →</Link><p className="mt-1 text-xs text-muted-foreground">{s.module} · {s.detail}</p></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('nothingWaiting')}</p>}</Card>
   <Card className="space-y-3 p-5"><h3 className="font-semibold">{t('standsOut')}</h3>{!o?<p className="text-sm text-muted-foreground">{t('notRunning')}</p>:<ul className="space-y-3 text-sm">{o.notes.behind&&<li>{t('behind',{group:o.notes.behind})}</li>}{o.notes.slowest&&<li>{t('slowest',{module:t('modules.'+o.notes.slowest.module),pct:o.notes.slowest.pct})}{o.notes.slowest.daysLeft!==null&&o.notes.slowest.daysLeft>=0&&' '+t('days',{days:o.notes.slowest.daysLeft})}</li>}{!!o.notes.complete.length&&<li>{t('complete',{groups:o.notes.complete.join(', ')})}</li>}{!o.notes.behind&&!o.notes.slowest&&!o.notes.complete.length&&<li className="text-muted-foreground">{t('ordinary')}</li>}</ul>}</Card>
  </div>
  <details className="rounded-lg border border-border p-5"><summary className="cursor-pointer text-sm font-medium">{ta('readiness')} · {t('steps',{done:readiness.done,total:readiness.total})}</summary><ul className="mt-3 divide-y divide-border">{readiness.steps.map(s=><li key={s.module+'.'+s.label} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span><Link href={s.href} className="text-primary hover:underline">{s.label}</Link><span className="mt-1 block text-xs text-muted-foreground">{s.detail}</span></span><span className="text-xs text-muted-foreground">{ta(s.done?'complete':'pending')}</span></li>)}</ul></details>
 </section>;
}
