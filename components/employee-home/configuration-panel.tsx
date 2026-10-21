import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {Card,Button,inputCls} from '@/components/ui';
import {localeNames,locales} from '@/i18n/config';
import {DASHBOARD_LAYOUT_ROLES} from '@/lib/dashboard-layout';
import {HR_LOCAL_TZ} from '@/lib/hr-date';
import {employeeHomeConfigurationCompanies,readEmployeeHomeConfigurationEditor,employeeHomeConfigurationHistory,readEmployeeHomeConfigurationVersion} from '@/core/employee-home-configuration';
import {HomeConfigurationEditor} from './configuration-editor';

const PAGE='/admin/settings/dashboard';
export type HomeConfigurationSelection={companyId?:string|string[];role?:string|string[];before?:string|string[];version?:string|string[]};
export async function HomeConfigurationPanel({session,selection}:{session:SessionContext;selection:HomeConfigurationSelection}){
 const [t,names,audience,quick,task,locale,companies]=await Promise.all([getTranslations('employeeHome.configuration'),getTranslations('employeeHome.templateNames'),getTranslations('dashboardCardConfig.audience'),getTranslations('employeeHome.quickActions'),getTranslations('employeeHome.taskNames'),getLocale(),employeeHomeConfigurationCompanies(session)]);
 if(Object.values(selection).some(Array.isArray))notFound();
 const chosen=selection.companyId as string|undefined,audienceRole=(selection.role as string|undefined)??'employee';
 if(!DASHBOARD_LAYOUT_ROLES.some(role=>role===audienceRole))notFound();
 const companyId=chosen??(companies.length===1?companies[0].id:undefined);
 if(companyId!==undefined&&!companies.some(company=>company.id===companyId))notFound();
 const number=(value:string|string[]|undefined)=>{if(value===undefined)return undefined;if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)notFound();return Number(value);};
 const beforeOrdinal=number(selection.before),historicalOrdinal=number(selection.version);
 const address=(extra:Record<string,string>={})=>PAGE+'?'+new URLSearchParams({section:'content',...(companyId?{homeCompanyId:companyId}:{}),homeRole:audienceRole,...extra});
 const current=companyId?await readEmployeeHomeConfigurationEditor(session,{companyId,audienceRole}):null;
 const [history,historical]=companyId?await Promise.all([
  employeeHomeConfigurationHistory(session,{companyId,audienceRole,beforeOrdinal}),
  historicalOrdinal===undefined?Promise.resolve(null):readEmployeeHomeConfigurationVersion(session,{companyId,audienceRole,ordinal:historicalOrdinal}),
 ]):[null,null];
 if(historicalOrdinal!==undefined&&!historical)notFound();
 const timestamp=(value:string)=>new Intl.DateTimeFormat(locale,{timeZone:HR_LOCAL_TZ,year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(value));
 return <div className="space-y-6">
  <Card className="space-y-4 p-5"><h2 className="text-lg font-semibold">{t('title')}</h2><p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p>
   {companies.length===0?<p role="status" className="text-sm">{t('noCompanies')}</p>:<form action={PAGE} method="get" className="flex flex-wrap items-end gap-3">
    <input type="hidden" name="section" value="content"/>
    <label className="min-w-0 flex-1 space-y-1 text-sm"><span className="block">{t('company')}</span><select className={inputCls+' min-h-11'} name="homeCompanyId" required defaultValue={companyId??''}><option value="" disabled>{t('chooseCompany')}</option>{companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
    <label className="space-y-1 text-sm"><span className="block">{t('audience')}</span><select className={inputCls+' min-h-11'} name="homeRole" defaultValue={audienceRole}>{DASHBOARD_LAYOUT_ROLES.map(role=><option key={role} value={role}>{audience(role)}</option>)}</select></label>
    <Button type="submit" variant="outline" className="min-h-11">{t('show')}</Button>
   </form>}
  </Card>
  {current&&!historical&&<Card className="space-y-5 p-5"><p className="text-sm text-muted-foreground">{current.ordinal===0?t('defaults'):t('version',{version:current.ordinal})}</p><HomeConfigurationEditor key={`${current.companyId}:${current.audienceRole}:${current.ordinal}`} initial={current}/></Card>}
  {historical&&<Card className="space-y-4 p-5"><h3 className="font-semibold">{t('viewingVersion',{version:historical.ordinal})}</h3><p className="text-sm">{historical.reason}</p><p className="text-sm text-muted-foreground">{timestamp(historical.createdAt)}</p>
   <dl className="space-y-3 text-sm"><div><dt className="font-medium">{t('quickTitle')}</dt><dd>{historical.configuration.quickActions.length?historical.configuration.quickActions.map(key=>quick(key)).join(' · '):t('notConfigured')}</dd></div>
    <div><dt className="font-medium">{t('teamVisibility')}</dt><dd>{t(historical.configuration.teamVisibility)}</dd></div>
    <div><dt className="font-medium">{t('celebrationsEnabled')}</dt><dd>{historical.configuration.celebrations.enabled?t('enabled')+' · '+t(historical.configuration.celebrations.scope):t('off')}</dd></div>
    <div><dt className="font-medium">{t('effortTitle')}</dt><dd>{Object.keys(historical.configuration.effortMinutes).length?<ul>{Object.entries(historical.configuration.effortMinutes).map(([kind,minutes])=><li key={kind}>{task(kind)} · {t('minutes',{minutes:minutes!})}</li>)}</ul>:t('notConfigured')}</dd></div>
   </dl>
   {historical.configuration.templates.map(template=><details key={template.key} className="rounded-md border p-3"><summary className="flex min-h-11 cursor-pointer items-center font-medium">{names(template.key)}</summary><p className="mt-2 text-sm text-muted-foreground">{template.enabled?t('enabled'):t('off')} · {t('priority')}: {new Intl.NumberFormat(locale).format(template.priority)}</p><dl className="mt-3 space-y-3">{locales.map(language=><div key={language}><dt className="text-sm font-medium">{localeNames[language]}</dt><dd lang={language} className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{template.text[language]}</dd></div>)}</dl></details>)}
   <Link className="inline-flex min-h-11 items-center text-sm underline" href={address()}>{t('editCurrent')}</Link>
  </Card>}
  {history&&<Card className="space-y-4 p-5"><h3 className="font-semibold">{t('history')}</h3>{history.items.length===0?<p className="text-sm text-muted-foreground">{t('historyEmpty')}</p>:<ol className="divide-y">{history.items.map(item=><li key={item.id} className="space-y-2 py-3">
   <div className="flex flex-wrap items-center justify-between gap-2"><Link className="inline-flex min-h-11 items-center text-sm font-medium underline" href={address({homeVersion:String(item.ordinal)})}>{t('version',{version:item.ordinal})}</Link><time className="text-xs text-muted-foreground" dateTime={item.createdAt}>{timestamp(item.createdAt)}</time></div>
   <p className="break-words text-sm">{item.reason}</p><details className="text-xs text-muted-foreground"><summary className="flex min-h-11 cursor-pointer items-center">{t('auditReference')}</summary><code className="break-all">{item.createdByUserId}</code></details>
  </li>)}</ol>}{history.nextBeforeOrdinal!==null&&<Link className="inline-flex min-h-11 items-center text-sm underline" href={address({homeBeforeOrdinal:String(history.nextBeforeOrdinal)})}>{t('older')}</Link>}</Card>}
  <p className="text-sm"><Link href="/admin/notice-board" className="inline-flex min-h-11 items-center underline">{t('manageNotices')}</Link></p>
 </div>;
}
