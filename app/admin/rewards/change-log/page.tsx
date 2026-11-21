import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {rewardConfigChangeLog,rewardConfigAreas,rewardConfigLogCompanies} from '@/packs/rewards/config-change';
import {PageHeader,Button,Field,inputCls,tableWrapCls,theadCls,thCls,tbodyCls} from '@/components/ui';
import {changeLogFilter,changeLogQuery,type ChangeLogParams} from './filters';

/** Board 60f1fdcd: every Rewards configuration change, newest first, with who, when, what changed and why. */
export default async function Page({searchParams}:{searchParams:Promise<ChangeLogParams>}){
 const s=await getSession(),t=await getTranslations('rewardConfig'),nav=await getTranslations('nav'),p=await searchParams,filter=changeLogFilter(p);
 let log;try{log=await rewardConfigChangeLog(s,filter);}catch{return<div className="space-y-3"><PageHeader title={nav('rewardsChangeLog')}/><p>{t('noAccess')}</p></div>;}
 const companies=await rewardConfigLogCompanies(s).catch(()=>[] as {id:string;name:string}[]);
 const locale=await getLocale(),time=new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'});
 return<div className="space-y-6"><PageHeader title={nav('rewardsChangeLog')} description={t('logHelp')}/>
  <form className="flex flex-wrap items-end gap-3">
   <Field label={t('area')}><select name="area" defaultValue={filter.area??''} className={inputCls}><option value="">{t('allAreas')}</option>{rewardConfigAreas.map(area=><option key={area} value={area}>{t(`areas.${area}`)}</option>)}</select></Field>
   <Field label={t('company')}><select name="company" defaultValue={filter.companyId??''} className={inputCls}><option value="">{t('allCompanies')}</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
   <Field label={t('person')}><input name="actor" defaultValue={filter.actor??''} maxLength={120} className={inputCls}/></Field>
   <Field label={t('from')}><input type="date" name="from" defaultValue={filter.from??''} className={inputCls}/></Field>
   <Field label={t('to')}><input type="date" name="to" defaultValue={filter.to??''} className={inputCls}/></Field>
   <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" name="high" value="1" defaultChecked={!!filter.highImpact}/>{t('highImpactOnly')}</label>
   <Button variant="outline">{t('filter')}</Button>
   <a className="text-sm text-primary underline" href={`/admin/rewards/change-log/export?${changeLogQuery(p,{page:undefined})}`} download>{t('exportExcel')}</a>
  </form>
  <div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['when','person','areaColumn','item','changes','reasonColumn'].map(k=><th key={k} scope="col" className={thCls}>{t(k)}</th>)}</tr></thead>
   <tbody className={tbodyCls}>{log.rows.map(row=>{const lines=Array.isArray((row.summary as {lines?:unknown}).lines)?(row.summary as {lines:{key:string;label:string;before:string|null;after:string|null}[]}).lines:[];
    return<tr key={row.id} className="align-top"><td className="whitespace-nowrap px-3 py-3">{time.format(new Date(row.at))}</td><td className="px-3 py-3">{row.actorKind==='system'?t('system'):row.actorName??t('unknownPerson')}</td>
     <td className="px-3 py-3">{t(`areas.${row.area}`)}{row.highImpact&&<span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{t('highImpactBadge')}</span>}</td>
     <td className="px-3 py-3"><span className="font-medium">{row.itemLabel}</span>{row.companyNames.length>0&&<span className="block text-xs text-muted-foreground">{row.companyNames.slice(0,3).join(', ')}{row.companyNames.length>3?` +${row.companyNames.length-3}`:''}</span>}<span className="block text-xs text-muted-foreground">{t(`actions.${row.action}`)}{row.versionRef?` · v${row.versionRef}`:''}</span></td>
     <td className="px-3 py-3">{lines.length?<details><summary className="cursor-pointer">{t('changedValues',{count:row.changedCount})}</summary><table className="mt-2 text-xs"><tbody>{lines.map(line=><tr key={line.key}><th scope="row" className="pr-3 text-left font-normal">{line.label}</th><td className="pr-3 tabular-nums text-muted-foreground">{line.before??'—'}</td><td className="tabular-nums">{line.after??'—'}</td></tr>)}</tbody></table></details>:<span className="text-muted-foreground">{t('changedValues',{count:row.changedCount})}</span>}</td>
     <td className="max-w-xs px-3 py-3">{row.reason}</td></tr>;})}</tbody></table>
   {!log.rows.length&&<p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>}</div>
  <nav className="flex gap-4 text-sm" aria-label={t('pages')}>{log.page>1&&<Link className="text-primary underline" href={`?${changeLogQuery(p,{page:String(log.page-1)})}`}>{t('previous')}</Link>}{log.hasMore&&<Link className="text-primary underline" href={`?${changeLogQuery(p,{page:String(log.page+1)})}`}>{t('next')}</Link>}</nav>
 </div>;
}
