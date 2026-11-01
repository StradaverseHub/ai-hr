import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {Badge} from '@/components/ui/badge';
import {RUNNERS,type RunnerSnapshot} from '@/lib/runner-control-model';
import {RunnerControls} from './runner-controls';
export async function RunnerInventory({snapshot,canControl}:{snapshot:RunnerSnapshot|null;canControl:boolean}) {
 const t=await getTranslations('runnerControl');
 const ordered=[...RUNNERS].sort((a,b)=>{const attention=(id:string)=>['failed','stale','stopped'].includes(snapshot?.runners.find(row=>row.id===id)?.health??'')?0:1;return attention(a.id)-attention(b.id);});
 return <section aria-labelledby="runner-control-title" className="space-y-3">
  <div><h2 id="runner-control-title" className="text-lg font-semibold">{t('title')}</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">{t('description')}</p></div>
  <Card className="p-4">
   <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t('environment')}: {snapshot?t(`environmentName.${snapshot.environment}`):t('unavailable')}</span><Link href="/admin/scheduled-actions" className="text-sm text-primary underline underline-offset-4">{t('refresh')}</Link></div>
   <p className="mt-2 text-sm text-muted-foreground">{snapshot?t('scopeNote'):t('controllerMissing')}</p>
   {snapshot&&<p className="mt-2 text-xs text-muted-foreground">{t('checkedAt')}: {new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(snapshot.checkedAt))} MYT</p>}
  </Card>
  <div className="divide-y divide-border rounded-xl border border-border bg-card">
   {ordered.map(entry=>{
    const status=snapshot?.runners.find(row=>row.id===entry.id);
    return <div key={entry.id} className="p-4 sm:p-5">
     <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{t(`jobs.${entry.id}.name`)}</h3><p className="mt-1 max-w-prose text-sm text-muted-foreground">{t(`jobs.${entry.id}.description`)}</p></div>
      <div className="flex flex-wrap gap-2"><Badge variant={status?.hold?'warning':'default'}>{!status?t('unavailable'):status.hold?t('held'):!status.managed?t('external'):status.enabled?t('enabled'):t('disabled')}</Badge>{status&&<Badge variant={status.health==='failed'?'danger':status.health==='success'?'success':'default'}>{t(`health.${status.health}`)}</Badge>}</div>
     </div>
     <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-muted-foreground">{t('schedule')}</dt><dd className="mt-1 break-words">{status?.schedule??t('unavailable')}</dd></div>
      <div><dt className="text-muted-foreground">{t('lastRun')}</dt><dd className="mt-1">{status?.lastRun??t('noEvidence')}</dd></div>
      <div><dt className="text-muted-foreground">{t('nextRun')}</dt><dd className="mt-1">{status?.nextRun??t('noEvidence')}</dd></div>
     </dl>
     <p className="mt-3 text-sm"><span className="text-muted-foreground">{t('results')}: </span>{entry.destination?<Link className="text-primary underline underline-offset-4" href={entry.destination}>{t(`jobs.${entry.id}.results`)}</Link>:t(`jobs.${entry.id}.results`)}</p>
     {status?.note&&<p className="mt-2 text-sm text-muted-foreground">{status.note}</p>}
     {status?.hold&&<p className="mt-2 text-sm">{t('holdNote')}</p>}
     {canControl&&status&&<RunnerControls key={status.revision} runner={status} frequency={entry.frequency}/>}
    </div>;
   })}
  </div>
 </section>;
}
