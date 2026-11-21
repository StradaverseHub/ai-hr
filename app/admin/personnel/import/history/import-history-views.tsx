/**
 * Reusable Import History views (ADR-0155) for every personnel import kind. Server components; data
 * arrives already RLS-scoped from core/import-history (attempts by listed company, items by own company).
 */
import { ExportDownloadLink } from '@/components/export-download-link';
import Link from 'next/link';
import {getTranslations,getFormatter} from 'next-intl/server';
import {IMPORT_HISTORY_KINDS,importAttemptTotals,importAttemptStatus,type ImportAttemptStatus,type ImportHistoryKind,type ImportKind} from '@/lib/import-history';
import type {ImportAttemptDetail,ImportHistoryRow} from '@/core/import-history';
import type {InformationLogRow} from '@/lib/information-correction';
import {personnelColumnLabel} from '@/lib/personnel-import-contract';
import {movementImportFieldLabel} from '@/lib/movement-import-issues';
import {formatImportActor,formatImportBatch} from '@/lib/import-reference';
import {hasImportErrorLog} from '@/lib/import-error-log-kinds';
export const IMPORT_HISTORY_PATH='/admin/personnel/import/history';
const dateTime={dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'} as const;
/** ccd3a65c — one look for all three pages: bordered card, muted header row, the same cell padding. */
export const historyTableCls='w-full text-left text-sm',historyHeadCls='bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground',historyCellCls='p-3';
const STATUS_TONE:Partial<Record<ImportAttemptStatus,string>>={succeeded:'text-emerald-700 dark:text-emerald-400',partial:'text-amber-700 dark:text-amber-400',failed:'text-destructive'};
export async function ImportStatusText({status}:{status:ImportAttemptStatus}){
 const t=await getTranslations('people.importHistory');
 return <span className={'font-medium '+(STATUS_TONE[status]??'')}>{t(`states.${status}`)}</span>;
}
export async function ImportKindFilter({active}:{active?:ImportHistoryKind}){
 const t=await getTranslations('people.importHistory');
 const chip=(selected:boolean)=>`inline-flex min-h-9 items-center rounded-full border px-3 text-sm ${selected?'border-primary bg-primary/10 font-medium text-primary':'text-muted-foreground'}`;
 return <nav aria-label={t('filterLabel')} className="flex flex-wrap gap-2"><Link className={chip(!active)} href={IMPORT_HISTORY_PATH} aria-current={!active?'page':undefined}>{t('filterAll')}</Link>{IMPORT_HISTORY_KINDS.map(kind=><Link key={kind} className={chip(active===kind)} href={`${IMPORT_HISTORY_PATH}?kind=${kind}`} aria-current={active===kind?'page':undefined}>{t(`kinds.${kind}`)}</Link>)}</nav>;
}
/** ccd3a65c — every import with Total, Successful and Failed; each row opens its Import Log. */
export async function ImportHistoryTable({items}:{items:ImportHistoryRow[]}){
 const t=await getTranslations('people.importHistory'),format=await getFormatter(),labels=await getTranslations('importLog'),problems=await getTranslations('importProblems');
 // 8d02748a — the file name sits under the batch number, so the separate File column is folded in.
 const heads=[t('reference'),t('type'),t('time'),t('user'),t('companies'),t('total'),t('successful'),t('failed'),t('status')];
 return <div className="overflow-x-auto rounded-xl border bg-card"><table className={historyTableCls}><thead className={historyHeadCls}><tr>{heads.map((label,index)=><th key={index} scope="col" className={historyCellCls+(index>=5&&index<=7?' text-right':'')}>{label}</th>)}</tr></thead>
  <tbody>{items.map(item=><tr key={item.cursor} className="border-t align-top">
   <td className={historyCellCls}><Link href={item.source==='attempt'?`${IMPORT_HISTORY_PATH}/${item.id}`:`${IMPORT_HISTORY_PATH}/runs/${item.id}`} className="font-medium text-primary underline" aria-label={t('openLog',{file:item.sourceName||t('pasted')})}>{formatImportBatch(labels,item.id)}</Link><span className="block break-all text-xs text-muted-foreground">{item.sourceName||t('pasted')}</span>
    {/* Board d3ba1e9f — the standard Error Log of every entry whose kind has a registered source. */}
    {hasImportErrorLog(item.kind,item.source)&&<ExportDownloadLink className="mt-1 inline-block text-xs text-primary underline" href={`${IMPORT_HISTORY_PATH}/${item.id}/error-log`} aria-label={`${problems('downloadLog')} · ${formatImportBatch(labels,item.id)}`}>{problems('downloadLog')}</ExportDownloadLink>}</td>
   <td className={historyCellCls}>{item.kind?t(`kinds.${item.kind}`):<span className="text-muted-foreground">{t('kinds.notRecorded')}</span>}</td>
   <td className={historyCellCls+' whitespace-nowrap'}>{format.dateTime(item.createdAt,dateTime)}</td>
   <td className={historyCellCls}>{formatImportActor(labels,item.createdByActor)}</td>
   <td className={historyCellCls}>{item.companies.join(', ')||'—'}</td>
   <td className={historyCellCls+' text-right tabular-nums'}>{item.total}</td>
   <td className={historyCellCls+' text-right tabular-nums'}>{item.successful}</td>
   <td className={historyCellCls+' text-right tabular-nums'}>{item.failed}</td>
   <td className={historyCellCls}><ImportStatusText status={item.status}/></td>
  </tr>)}</tbody></table>{items.length===0&&<p className="p-6 text-sm text-muted-foreground">{t('noAttempts')}</p>}</div>;
}
export async function ImportAttemptSummary({item}:{item:ImportAttemptDetail}){
 const t=await getTranslations('people.importHistory'),format=await getFormatter(),labels=await getTranslations('importLog');
 const status=importAttemptStatus(item.plan,item.events),totals=importAttemptTotals(item.plan,item.events);
 return <section className="space-y-4 rounded-xl border bg-card p-5"><dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
  <div><dt className="text-muted-foreground">{t('type')}</dt><dd>{t(`kinds.${item.kind}`)}</dd></div>
  <div><dt className="text-muted-foreground">{t('status')}</dt><dd><ImportStatusText status={status}/></dd></div>
  <div><dt className="text-muted-foreground">{t('time')}</dt><dd>{format.dateTime(item.createdAt,dateTime)}</dd></div>
  <div><dt className="text-muted-foreground">{t('user')}</dt><dd>{formatImportActor(labels,item.createdByActor)}</dd></div>
  <div><dt className="text-muted-foreground">{t('companies')}</dt><dd>{item.companies.join(', ')||'—'}</dd></div>
  <div><dt className="text-muted-foreground">{t('totalRows')}</dt><dd className="tabular-nums">{totals.total}</dd></div>
  <div><dt className="text-muted-foreground">{t('successful')}</dt><dd className="tabular-nums">{totals.successful}</dd></div>
  <div><dt className="text-muted-foreground">{t('failed')}</dt><dd className="tabular-nums">{totals.failed}</dd></div>
  <div className="sm:col-span-2 lg:col-span-4"><dt className="text-muted-foreground">{t('fingerprint')}</dt><dd className="break-all font-mono text-xs">{item.sourceHash}</dd></div>
 </dl>{item.canDownloadSource?<ExportDownloadLink className="inline-flex rounded-lg border px-4 py-2 text-sm font-medium" href={`${IMPORT_HISTORY_PATH}/${item.id}/source`}>{t('downloadSource')}</ExportDownloadLink>:<p className="text-xs text-muted-foreground">{t('sourceRestricted')}</p>}
 {item.plan.issues?.length>0&&<div role="alert" className="space-y-1 text-sm"><p className="font-medium">{t('fileIssues')}</p><ul className="list-disc pl-5 text-destructive">{item.plan.issues.map((issue,i)=><li key={i}>{issue.reason}</li>)}</ul></div>}
 </section>;
}
export async function ImportAttemptEvents({item}:{item:ImportAttemptDetail}){
 const t=await getTranslations('people.importHistory'),format=await getFormatter(),labels=await getTranslations('importLog');
 return <section className="space-y-3 rounded-xl border bg-card p-5"><h2 className="font-semibold">{t('audit')}</h2><ol className="divide-y">{item.events.map(event=><li key={event.id} className="space-y-1 py-3 text-sm">
  <p className="font-medium">{t(`events.${event.kind}`)} · {format.dateTime(event.createdAt,dateTime)}</p>
  <p className="text-xs text-muted-foreground">{formatImportActor(labels,event.actor)}</p>
  {event.reason&&<p>{t('eventReason',{reason:event.reason})}</p>}
  {typeof event.detail.message==='string'&&<p className="text-destructive">{event.detail.message}</p>}
 </li>)}</ol></section>;
}
type AllocationState={operation?:string;effectiveDate?:string;rows?:{code:string;label:string;hundredths:number}[]};
const percent=(hundredths:number)=>`${Math.floor(hundredths/100)}.${String(hundredths%100).padStart(2,'0')}`;
async function ItemValue({kind,value}:{kind:ImportKind;value:unknown}){
 const t=await getTranslations('people.importHistory');
 if(value==null)return <span className="text-muted-foreground">—</span>;
 if(kind==='cost_allocations'){
  const state=value as AllocationState;
  if(state.operation==='none')return <span className="text-muted-foreground">{t('allocation.none')}</span>;
  if(!state.rows?.length)return <span>{t('allocation.clear')}</span>;
  return <ul>{state.rows.map((r,i)=><li key={i}>{r.code}{r.label&&r.label!==r.code?` (${r.label})`:''} · {percent(r.hundredths)}%</li>)}</ul>;
 }
 if(kind==='bank_statutory'){
  // 0db97f14 — each field the import changed, captioned as on the Bank & Statutory tab.
  const root=await getTranslations();const fields=Object.entries((value as {fields?:Record<string,string>}).fields??{});
  const resolve=(key:string,fallback:string)=>root.has(key)?root(key):fallback;
  return <dl className="space-y-1">{fields.map(([column,v])=><div key={column}><dt className="inline text-muted-foreground">{personnelColumnLabel(column,'employee',resolve)}: </dt><dd className="inline break-all">{v===''?t('bankStatutory.blank'):v}</dd></div>)}</dl>;
 }
 if(kind==='information_correction'){
  const root=await getTranslations('people.informationCorrection');const state=value as {values?:Record<string,string|null>;reason?:string};return <div className="space-y-1 text-sm">{Object.entries(state.values??{}).map(([field,v])=><p key={field}>{root(`fields.${field}`)}: {v??'—'}</p>)}<p>{root('reason')}: {state.reason}</p></div>;
 }
 if(kind==='movement'){
  // ac6645ec — one movement: its event type and date, then each changed field's value on this side.
  const root=await getTranslations(),resolve=(key:string,fallback:string)=>root.has(key)?root(key):fallback;
  const state=value as {eventLabel?:string;effectiveDate?:string;movementId?:string|null;scheduled?:boolean;sourceRows?:number[];values?:Record<string,string|null>;action?:'update'|'delete';reason?:string;closedPayrollPeriods?:string[]};
  const values=Object.entries(state.values??{});
  return <div className="space-y-1"><p className="font-medium">{state.eventLabel??t('movementItem.movement')} · {state.effectiveDate}</p>
   {state.sourceRows?.length?<p className="text-xs text-muted-foreground">{t('movementItem.rows',{rows:state.sourceRows.join(', ')})}</p>:null}
   {/* 646355e5 slice C — an Update or Delete of an existing movement, with the reason it was given. */}
   {state.action&&<p className="text-xs text-muted-foreground">{t(`movementItem.${state.action}`)}{state.reason?' · '+t('movementItem.reason',{reason:state.reason}):''}</p>}
   {!!state.closedPayrollPeriods?.length&&<p className="text-xs text-muted-foreground">{t('movementItem.closedPayroll',{periods:state.closedPayrollPeriods.join(', ')})}</p>}
   {!state.movementId&&state.action!=='delete'&&<p className="text-xs text-muted-foreground">{t('movementItem.noMovement')}</p>}
   {state.scheduled&&<p className="text-xs text-muted-foreground">{t('movementItem.scheduled')}</p>}
   {values.length>0&&<dl className="space-y-1">{values.map(([field,v])=><div key={field}><dt className="inline text-muted-foreground">{movementImportFieldLabel(field,resolve)}: </dt><dd className="inline break-all">{v??'—'}</dd></div>)}</dl>}</div>;
 }
 if(kind==='employee_full'){
  // 524303d9 — the employee this import created (no identity, salary or bank value is recorded).
  const state=value as {employeeCode?:string;fullName?:string};
  return <span>{t('employeeFull.created',{code:state.employeeCode||'—',name:state.fullName??''})}</span>;
 }
 // Kinds without a dedicated renderer show their recorded fields as plain pairs.
 if(typeof value==='object')return <dl className="space-y-1">{Object.entries(value as Record<string,unknown>).map(([k,v])=><div key={k}><dt className="inline text-muted-foreground">{k}: </dt><dd className="inline break-all">{typeof v==='object'?JSON.stringify(v):String(v)}</dd></div>)}</dl>;
 return <span>{String(value)}</span>;
}
export async function ImportAttemptItems({item}:{item:ImportAttemptDetail}){
 const t=await getTranslations('people.importHistory');
 return <section className="space-y-3 rounded-xl border bg-card p-5"><h2 className="font-semibold">{t('items')}</h2><p className="text-sm text-muted-foreground">{t('itemsHint')}</p>
  {item.items.length===0?<p className="text-sm">{t('noItems')}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['colRecord','colCompany','colResult','colBefore','colAfter'].map(k=><th key={k} className="p-3">{t(k)}</th>)}</tr></thead>
  <tbody>{item.items.map(row=><tr key={row.id} className="border-t align-top">
   <td className="p-3 font-medium">{row.label}</td><td className="p-3">{row.companyName??'—'}</td>
   <td className="p-3">{row.status==='applied'?t('itemApplied'):<span className="text-destructive">{t('itemFailed')}</span>}{row.errors.length>0&&<ul className="mt-1 text-xs text-destructive">{row.errors.map((e,i)=><li key={i}>{e}</li>)}</ul>}</td>
   <td className="p-3"><ItemValue kind={item.kind} value={row.before}/></td><td className="p-3"><ItemValue kind={item.kind} value={row.after}/></td>
  </tr>)}</tbody></table></div>}</section>;
}

/** ccd3a65c — the Import Log of an Information-Only Correction file: every row, saved or not, with what
 * changed and why a row was not saved. Rows arrive filtered to companies the viewer can view. */
export async function InformationImportLog({rows}:{rows:InformationLogRow[]}){
 const t=await getTranslations('people.importHistory'),fields=await getTranslations('people.informationCorrection');
 const result={saved:t('log.saved'),unchanged:t('log.unchanged'),not_saved:t('log.notSaved'),not_confirmed:t('log.notConfirmed')};
 const tone={saved:'font-medium text-emerald-700 dark:text-emerald-400',unchanged:'text-muted-foreground',not_saved:'font-medium text-destructive',not_confirmed:'text-muted-foreground'};
 const heads=[t('log.row'),t('log.employee'),t('log.result'),t('log.field'),t('log.before'),t('log.after'),t('log.reason')];
 return <section className="space-y-3 rounded-xl border bg-card p-5"><div><h2 className="font-semibold">{t('log.title')}</h2><p className="text-sm text-muted-foreground">{t('log.hint')}</p></div>
  {rows.length===0?<p className="text-sm">{t('log.empty')}</p>:<div className="overflow-x-auto"><table className={historyTableCls}><thead className={historyHeadCls}><tr>{heads.map((label,index)=><th key={index} scope="col" className={historyCellCls}>{label}</th>)}</tr></thead>
  <tbody>{rows.map(row=><tr key={row.row} className="border-t align-top">
   <td className={historyCellCls+' tabular-nums'}>{row.row}</td>
   <td className={historyCellCls}>{[row.employeeCode||'—',row.name].filter(Boolean).join(' · ')}</td>
   <td className={historyCellCls}><span className={tone[row.result]}>{result[row.result]}</span></td>
   {row.errors.length?<td colSpan={4} className={historyCellCls}><ul className="space-y-1 text-destructive">{row.errors.map((error,index)=><li key={index}>{error}</li>)}</ul></td>
   :row.changes.length?<><td className={historyCellCls}><ul className="space-y-1">{row.changes.map(change=><li key={change.field}>{fields(`fields.${change.field}`)}</li>)}</ul></td>
    <td className={historyCellCls}><ul className="space-y-1">{row.changes.map(change=><li key={change.field}>{change.before??'—'}</li>)}</ul></td>
    <td className={historyCellCls}><ul className="space-y-1">{row.changes.map(change=><li key={change.field} className="font-medium">{change.after??'—'}</li>)}</ul></td>
    <td className={historyCellCls}>{row.reason??'—'}</td></>
   :<><td colSpan={3} className={historyCellCls+' text-muted-foreground'}>{t('log.nothingChanged')}</td><td className={historyCellCls}>{row.reason??'—'}</td></>}
  </tr>)}</tbody></table></div>}</section>;
}
