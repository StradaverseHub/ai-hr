'use client';
import { ExportDownloadLink } from '@/components/export-download-link';
import Link from 'next/link';
import type {ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {Settings,Download,ArrowLeft,ArrowRight,ChevronRight,RefreshCw,Info,FileInput} from 'lucide-react';
import type {probationSummaryRows} from '@/packs/probation/service';
import {formatDmy} from '@/lib/date-display';
import {todayInKualaLumpur} from '@/lib/hr-date';
import type {ProbationReconciliationView} from '@/lib/probation-reconciliation';
import {ProbationReconciliationStatus} from './reconciliation-status';
import {TrackerFilterPanel} from './tracker-filter-panel';
import type {TrackerFilters} from './tracker-filters';
import {trackerPendingPart,trackerPlanParts,trackerRowAttention,trackerRowClosed,trackerRowFlags,trackerWaitingStep,type TrackerTone} from './tracker-row';

const FLAGS=['overdue','end_passed','ending14','low_result','kpi_submit','kpi_ack','overridden'] as const;
/** Tile colours as the prototype's TILE_DEFS: red for overdue and passed end dates, amber for the rest, plain for overrides. */
const TILE_TONE:Record<(typeof FLAGS)[number],'bad'|'warn'|'plain'>={overdue:'bad',end_passed:'bad',ending14:'warn',low_result:'warn',kpi_submit:'warn',kpi_ack:'warn',overridden:'plain'};
const CLOSED_TONE:Record<string,TrackerTone>={confirmed:'ok',not_confirmed:'bad',withdrawn:'warn'};
function filterQuery(filters:TrackerFilters,offset?:number){const query=new URLSearchParams();for(const[key,value]of Object.entries({...filters,offset:offset??filters.offset})){if(value!==undefined&&value!==''&&key!=='limit')query.set(key,String(value));}return query.toString();}
const Pill=({tone,children}:{tone:TrackerTone;children:ReactNode})=><span className="pct-pill" data-tone={tone}>{children}</span>;

/**
 * Probation tracker (lane M1; prototype Tracker): header with Export, the Personnel sync banner, seven counted tiles that
 * filter the list, the filter card and the case table. Every value is from the server-authorized summary page.
 */
export function ProbationTracker({data,filters,configure,warning,overdue,today:serverToday,reconciliation}:{data:Awaited<ReturnType<typeof probationSummaryRows>>;filters:TrackerFilters;configure:boolean;warning?:ReactNode;reconciliation?:ProbationReconciliationView;
 /** Working days overdue per KPI part id, streamed by the page after the list (app/lifecycle/probation/working-days-overdue.tsx). */
 overdue?:Readonly<Record<string,ReactNode>>;
 /** The HR calendar day the server read the page on (lib/hr-date). */
 today?:string}){
 const t=useTranslations('probation'),options=data.options,today=serverToday??todayInKualaLumpur();
 const roleName=(role:string|null|undefined,label?:string|null)=>label??(!role?'':t.has('roles.'+role)?t('roles.'+role):/^(routing:|group:|people$)/.test(role)?t('roles.approver'):role);
 const columns=['employee','organisation','endOn','plan','stage','waiting','due','flags','extensions','action'] as const;
 const paged=data.offset>0||data.hasMore;
 return <main className="pct">
  <p className="pct-crumb">{t('tracker.breadcrumb')}</p>
  <header className="pct-ph"><div><h1>{t('tracker.title')}</h1><p>{t('tracker.intro')}</p></div>
   <div className="pct-row">
    {configure&&<Link className="pct-btn pct-btn-ghost" href="/lifecycle/probation/intake"><FileInput size={16} aria-hidden="true"/>{t('tracker.links.intake')}</Link>}
    {configure&&<Link className="pct-btn pct-btn-ghost" href="/lifecycle/probation/settings"><Settings size={16} aria-hidden="true"/>{t('tracker.links.settings')}</Link>}
    <ExportDownloadLink className="pct-btn" href={'/lifecycle/probation/export?'+filterQuery(filters)} data-unsaved-guard="ignore"><Download size={16} aria-hidden="true"/>{t('export')}</ExportDownloadLink>
   </div>
  </header>
  <div className="pct-banner" data-testid="probation-sync-banner"><RefreshCw aria-hidden="true"/><div>{t.rich('tracker.synced',{b:chunks=><b>{chunks}</b>})}</div></div>
  {reconciliation&&<ProbationReconciliationStatus data={reconciliation} query={filterQuery(filters)}/>}
  {warning&&<div className="pct-warn">{warning}</div>}
  {filters.mine&&<div className="pct-banner" data-tone="info"><Info aria-hidden="true"/><div>{t('tracker.mineOnly')} <Link href={'/lifecycle/probation?'+filterQuery({...filters,mine:undefined},0)}>{t('tracker.mineClear')}</Link></div></div>}
  <nav className="pct-tiles" aria-label={t('tracker.summary')}>{FLAGS.map(flag=><Link className="pct-tile" data-tone={TILE_TONE[flag]} data-flag={flag} aria-current={filters.flag===flag?'page':undefined} href={'/lifecycle/probation?'+filterQuery({...filters,flag:filters.flag===flag?undefined:flag},0)} key={flag}><span>{t('tracker.tiles.'+flag)}</span><b>{data.totals[flag]}</b></Link>)}</nav>
  <TrackerFilterPanel key={filterQuery(filters)} options={options} filters={filters}/>
  <p className="pct-count" role="status">{paged?t('tracker.pageRows',{from:data.rows.length?data.offset+1:0,to:data.offset+data.rows.length,total:data.total}):t('tracker.caseCount',{shown:data.rows.length,total:data.total})}{filters.flag&&' · '+t('tracker.filteredBy',{tile:t('tracker.tiles.'+filters.flag)})}</p>
  <section className="pct-tw probation-list-table" aria-label={t('tracker.cases')}><table className="pct-table">
   <thead><tr>{columns.map(key=><th key={key} scope="col">{key==='action'?<span className="pct-sr">{t('tracker.columns.action')}</span>:key==='extensions'?<abbr title={t('tracker.columns.extensionsFull')}>{t('tracker.columns.extensions')}</abbr>:t('tracker.columns.'+key)}</th>)}</tr></thead>
   <tbody>{data.rows.length===0?<tr><td colSpan={columns.length}><p className="pct-empty">{t('tracker.empty')}</p></td></tr>:data.rows.map(row=>{
    const pending=trackerPendingPart(row),closed=trackerRowClosed(row),plan=trackerPlanParts(row),flags=trackerRowFlags(row,today),href='/lifecycle/probation/'+row.id;
    const stage=row.startStatus==='did_not_join'?<Pill tone="warn">{t('caseStates.didNotJoin')}</Pill>
     :closed?<Pill tone={CLOSED_TONE[row.state]??'plain'}>{t.has('caseStates.'+row.state)?t('caseStates.'+row.state):row.state}</Pill>
     :row.startStatus==='waiting_for_start'?t('caseStates.waitingForStart')
     :pending?(pending.type===3&&pending.cycle>1?t('tracker.stage.afterExtension',{stage:t('tracker.stage.3')}):t('tracker.stage.'+pending.type))
     :row.letterWaiting?row.letterWaiting.label
     :t.has('caseStates.'+row.state)?t('caseStates.'+row.state):row.state;
    const waiting=closed||row.startStatus==='did_not_join'?'—'
     :row.startStatus==='waiting_for_start'?t('tracker.startsOn',{date:formatDmy(row.startOn)})
     :pending?.waitingRole?t('tracker.waitingOn',{role:roleName(pending.waitingRole,pending.waitingLabel),name:pending.waitingName??t('signing.missing'),step:t('tracker.what.'+trackerWaitingStep(pending))})
     :!pending&&row.letterWaiting?.waitingRole?t('tracker.waitingOn',{role:roleName(row.letterWaiting.waitingRole),name:row.letterWaiting.waitingName??t('signing.missing'),step:t('tracker.what.letter')})
     :'—';
    const late=pending?.calendarDaysOverdue!==undefined&&!closed&&row.startStatus!=='waiting_for_start';
    return <tr key={row.id} data-case={row.id} className={trackerRowAttention(row,today)?'pct-hl':undefined}>
     <td data-label={t('tracker.columns.employee')}><Link className="pct-nm" href={href}>{row.employeeName}</Link><small>{[row.employeeCode??'—',row.grade,row.title??'—'].join(' · ')}</small></td>
     <td data-label={t('tracker.columns.organisation')}>{row.businessGroup??'—'}<small>{(row.businessUnit??'—')+' · '+(row.department??'—')}</small></td>
     <td data-label={t('tracker.columns.endOn')} className="pct-num">{formatDmy(row.endOn)}</td>
     <td data-label={t('tracker.columns.plan')}>{t('tracker.planMonths',{months:row.planMonths})}{plan.length>0&&<small>{t('tracker.planParts.'+(plan.length===2?'both':plan[0]===3?'p3':'p2'))}</small>}</td>
     <td data-label={t('tracker.columns.stage')}>{stage}</td>
     <td data-label={t('tracker.columns.waiting')}>{waiting}</td>
     <td data-label={t('tracker.columns.due')} className="pct-num">{!pending||closed||row.startStatus?'—':late?<b className="pct-late">{overdue?.[pending.id]??t('tracker.calendarOverdue',{days:pending.calendarDaysOverdue!})}</b>:formatDmy(pending.dueOn)}</td>
     <td data-label={t('tracker.columns.flags')}>{flags.length?<span className="pct-flags">{flags.map(flag=><Pill key={flag.key} tone={flag.tone}>{t('tracker.pills.'+flag.key,{band:flag.band??0})}</Pill>)}</span>:<span className="pct-muted">—</span>}</td>
     <td data-label={t('tracker.columns.extensionsFull')} className="pct-num">{t('tracker.extensionsUsed',{used:row.extensionCount,max:row.extensionMax??2})}</td>
     <td><Link className="pct-link" href={href}>{t('tracker.actions.'+(row.action??'open'))}<ChevronRight size={14} aria-hidden="true"/></Link></td>
    </tr>;})}</tbody>
  </table></section>
  {paged&&<div className="pct-row">{data.offset>0&&<Link className="pct-btn" href={'/lifecycle/probation?'+filterQuery(filters,Math.max(0,data.offset-data.limit))}><ArrowLeft size={16} aria-hidden="true"/>{t('previous')}</Link>}{data.hasMore&&<Link className="pct-btn" href={'/lifecycle/probation?'+filterQuery(filters,data.offset+data.limit)}>{t('next')}<ArrowRight size={16} aria-hidden="true"/></Link>}</div>}
 </main>;
}
