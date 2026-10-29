/**
 * Reusable Import History views (ADR-0155) for every personnel import kind. Server components; data
 * arrives already RLS-scoped from core/import-history (attempts by listed company, items by own company).
 */
import Link from 'next/link';
import {getTranslations,getFormatter} from 'next-intl/server';
import {IMPORT_KINDS,importAttemptCounts,importAttemptStatus,type ImportKind} from '@/lib/import-history';
import type {ImportAttemptDetail,ImportAttemptListItem} from '@/core/import-history';
import {personnelColumnLabel} from '@/lib/personnel-import-contract';
import {movementImportFieldLabel} from '@/lib/movement-import-issues';
export const IMPORT_HISTORY_PATH='/admin/personnel/import/history';
const dateTime={dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'} as const;
export async function ImportKindFilter({active}:{active?:ImportKind}){
 const t=await getTranslations('people.importHistory');
 const chip=(selected:boolean)=>`inline-flex min-h-9 items-center rounded-full border px-3 text-sm ${selected?'border-primary bg-primary/10 font-medium text-primary':'text-muted-foreground'}`;
 return <nav aria-label={t('filterLabel')} className="flex flex-wrap gap-2"><Link className={chip(!active)} href={IMPORT_HISTORY_PATH} aria-current={!active?'page':undefined}>{t('filterAll')}</Link>{IMPORT_KINDS.map(kind=><Link key={kind} className={chip(active===kind)} href={`${IMPORT_HISTORY_PATH}?kind=${kind}`} aria-current={active===kind?'page':undefined}>{t(`kinds.${kind}`)}</Link>)}</nav>;
}
export async function ImportAttemptTable({items}:{items:ImportAttemptListItem[]}){
 const t=await getTranslations('people.importHistory'),format=await getFormatter();
 return <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['reference','type','file','time','user','companies','records','status'].map(key=><th key={key} className="p-3">{t(key)}</th>)}</tr></thead>
  <tbody>{items.map(item=>{const status=importAttemptStatus(item.plan,item.events),counts=importAttemptCounts(item.plan,item.events);return <tr key={item.id} className="border-t align-top">
   <td className="p-3"><Link href={`${IMPORT_HISTORY_PATH}/${item.id}`} className="font-mono text-xs text-primary underline">{item.id.slice(0,8)}</Link></td>
   <td className="p-3">{t(`kinds.${item.kind}`)}</td><td className="p-3 break-all">{item.sourceName}</td>
   <td className="p-3 whitespace-nowrap">{format.dateTime(item.createdAt,dateTime)}</td>
   <td className="p-3"><span title={item.createdBy}>{item.createdByName??t('unknownUser')}</span></td>
   <td className="p-3">{item.companies.join(', ')||'—'}</td>
   <td className="p-3 whitespace-nowrap">{t('counts',counts)}</td>
   <td className="p-3"><span className="font-medium">{t(`states.${status}`)}</span></td>
  </tr>;})}</tbody></table>{items.length===0&&<p className="p-6 text-sm text-muted-foreground">{t('noAttempts')}</p>}</div>;
}
export async function ImportAttemptSummary({item}:{item:ImportAttemptDetail}){
 const t=await getTranslations('people.importHistory'),format=await getFormatter();
 const status=importAttemptStatus(item.plan,item.events),counts=importAttemptCounts(item.plan,item.events);
 return <section className="space-y-4 rounded-xl border p-5"><dl className="grid gap-4 text-sm sm:grid-cols-2">
  <div><dt className="text-muted-foreground">{t('type')}</dt><dd>{t(`kinds.${item.kind}`)}</dd></div>
  <div><dt className="text-muted-foreground">{t('status')}</dt><dd className="font-medium">{t(`states.${status}`)}</dd></div>
  <div><dt className="text-muted-foreground">{t('time')}</dt><dd>{format.dateTime(item.createdAt,dateTime)}</dd></div>
  <div><dt className="text-muted-foreground">{t('user')}</dt><dd title={item.createdBy}>{item.createdByName??t('unknownUser')}</dd></div>
  <div><dt className="text-muted-foreground">{t('companies')}</dt><dd>{item.companies.join(', ')||'—'}</dd></div>
  <div><dt className="text-muted-foreground">{t('records')}</dt><dd>{t('counts',counts)}</dd></div>
  <div className="sm:col-span-2"><dt className="text-muted-foreground">{t('fingerprint')}</dt><dd className="break-all font-mono text-xs">{item.sourceHash}</dd></div>
 </dl>{item.canDownloadSource?<Link className="inline-flex rounded-lg border px-4 py-2 text-sm font-medium" href={`${IMPORT_HISTORY_PATH}/${item.id}/source`}>{t('downloadSource')}</Link>:<p className="text-xs text-muted-foreground">{t('sourceRestricted')}</p>}
 {item.plan.issues?.length>0&&<div role="alert" className="space-y-1 text-sm"><p className="font-medium">{t('fileIssues')}</p><ul className="list-disc pl-5 text-destructive">{item.plan.issues.map((issue,i)=><li key={i}>{issue.reason}</li>)}</ul></div>}
 </section>;
}
export async function ImportAttemptEvents({item}:{item:ImportAttemptDetail}){
 const t=await getTranslations('people.importHistory'),format=await getFormatter();
 return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">{t('audit')}</h2><ol className="divide-y">{item.events.map(event=><li key={event.id} className="space-y-1 py-3 text-sm">
  <p className="font-medium">{t(`events.${event.kind}`)} · {format.dateTime(event.createdAt,dateTime)}</p>
  <p className="text-xs text-muted-foreground" title={event.actorId}>{event.actorName??t('unknownUser')}</p>
  {event.reason&&<p>{t('eventReason',{reason:event.reason})}</p>}
  {typeof event.detail.message==='string'&&<p className="text-destructive">{event.detail.message}</p>}
  {item.kind==='information_correction'&&Array.isArray(event.detail.rows)&&<ul className="space-y-1">{(event.detail.rows as {row:number;status:string;errors:string[]}[]).map(row=><li key={row.row}>{row.row} · {row.status} {row.errors.join(' ')}</li>)}</ul>}
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
  const state=value as {eventLabel?:string;effectiveDate?:string;movementId?:string|null;scheduled?:boolean;sourceRows?:number[];values?:Record<string,string|null>};
  const values=Object.entries(state.values??{});
  return <div className="space-y-1"><p className="font-medium">{state.eventLabel??t('movementItem.movement')} · {state.effectiveDate}</p>
   {state.sourceRows?.length?<p className="text-xs text-muted-foreground">{t('movementItem.rows',{rows:state.sourceRows.join(', ')})}</p>:null}
   {!state.movementId&&<p className="text-xs text-muted-foreground">{t('movementItem.noMovement')}</p>}
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
 return <section className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">{t('items')}</h2><p className="text-sm text-muted-foreground">{t('itemsHint')}</p>
  {item.items.length===0?<p className="text-sm">{t('noItems')}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['colRecord','colCompany','colResult','colBefore','colAfter'].map(k=><th key={k} className="p-3">{t(k)}</th>)}</tr></thead>
  <tbody>{item.items.map(row=><tr key={row.id} className="border-t align-top">
   <td className="p-3 font-medium">{row.label}</td><td className="p-3">{row.companyName??'—'}</td>
   <td className="p-3">{row.status==='applied'?t('itemApplied'):<span className="text-destructive">{t('itemFailed')}</span>}{row.errors.length>0&&<ul className="mt-1 text-xs text-destructive">{row.errors.map((e,i)=><li key={i}>{e}</li>)}</ul>}</td>
   <td className="p-3"><ItemValue kind={item.kind} value={row.before}/></td><td className="p-3"><ItemValue kind={item.kind} value={row.after}/></td>
  </tr>)}</tbody></table></div>}</section>;
}
