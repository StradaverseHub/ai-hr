import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {rewardConfigChangeExport} from '@/packs/rewards/config-change';
import {makeWorkbook} from '@/packs/rewards/setup-workbook';
import {csvSafeCell} from '@/lib/csv';
import {changeLogFilter,type ChangeLogParams} from '../filters';

/** Excel export of the filtered change log: the same reader population and order as the page, bounded, audited, and
 * every text cell formula-injection safe. */
export async function GET(request:Request){
 const s=await getSession(),t=await getTranslations('rewardConfig'),q=Object.fromEntries(new URL(request.url).searchParams) as ChangeLogParams;
 try{
  const {rows,truncated}=await rewardConfigChangeExport(s,changeLogFilter(q));
  const cell=(value:string|number|null|undefined)=>csvSafeCell(value??'');
  const sheet=rows.flatMap(row=>{const lines=Array.isArray((row.summary as {lines?:unknown}).lines)?(row.summary as {lines:{label:string;before:string|null;after:string|null}[]}).lines:[];
   const base={When:cell(row.at),Person:cell(row.actorKind==='system'?t('system'):row.actorName),Area:cell(t(`areas.${row.area}`)),Action:cell(t(`actions.${row.action}`)),Item:cell(row.itemLabel),Companies:cell(row.companyNames.join(', ')),Version:cell(row.versionRef),HighImpact:row.highImpact?'Yes':'No',Reason:cell(row.reason)};
   return lines.length?lines.map(line=>({...base,Changed:cell(line.label),Before:cell(line.before),After:cell(line.after)})):[{...base,Changed:cell(String(row.changedCount)),Before:'',After:''}];});
  if(truncated)sheet.push({When:cell(t('exportTruncated')),Person:'',Area:'',Action:'',Item:'',Companies:'',Version:'',HighImpact:'',Reason:'',Changed:'',Before:'',After:''});
  return new Response(new Uint8Array(makeWorkbook(sheet)),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="rewards-change-log.xlsx"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }catch{return new Response(t('noAccess'),{status:403,headers:{'Cache-Control':'private, no-store'}});}
}
