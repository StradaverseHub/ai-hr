import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {myEmployment,allowedCompanies} from '@/core/read';
import {orgChartSnapshot,orgChartDate} from '@/core/org-chart';
import {Card,PageHeader} from '@/components/ui';
import {OrgChart} from '@/components/org-chart';
import {OrgChartFilters} from './filters';
import {designateRoot} from './actions';
import type {OrgChartFilter} from '@/lib/org-chart-model';
export default async function OrgChartPage({searchParams}: {searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {s,scopeIds}=await scopedSession();const allowedIds=(await allowedCompanies(s)).map(company=>company.id);const params=await searchParams;const value=(key:string)=>typeof params[key]==='string'?params[key] as string:undefined;
 const own=await myEmployment(s);const requested=value('companyId');const defaultCompany=own&&allowedIds.includes(own.companyId)?own.companyId:scopeIds.length===1?scopeIds[0]:undefined;
 const filter:OrgChartFilter={asOf:orgChartDate(value('asOf')),companyId:requested===undefined?defaultCompany:allowedIds.includes(requested)?requested:'__outside_scope__',businessUnitId:value('businessUnitId'),departmentId:value('departmentId'),employmentType:value('employmentType'),status:value('status')??'all'};
 const snapshot=await orgChartSnapshot(s,{companyIds:allowedIds,filter});const t=await getTranslations('org');
 return <div className="mx-auto max-w-[1600px] space-y-6">
  <PageHeader title={t('title')} actions={<span className="text-sm text-muted-foreground">{t('peopleCount',{count:snapshot.employees.length})}</span>}/>
  {['hasSuperior','inactive','saved'].includes(value('notice')??'')&&<p role="status" className="rounded-lg border bg-muted/30 p-3 text-sm">{t('topLevel.'+value('notice'))}</p>}
  <Card className="p-5"><OrgChartFilters filter={filter} options={snapshot.options} restore={Object.keys(params).length===0}/></Card>
  <Card className="p-5" data-tour="org-chart">{snapshot.employees.length?<OrgChart employees={snapshot.employees} edges={snapshot.edges} filter={filter} canExport={snapshot.canManage}/>:<p>{t('filterEmpty')}</p>}</Card>
  {snapshot.canManage&&<Card className="space-y-4 p-5"><h2 className="font-semibold">{t('integrity.title')}</h2><p className="text-sm text-muted-foreground">{t('integrity.note')}</p>
   {snapshot.issues.length?<ul className="space-y-1 text-sm">{snapshot.issues.map(issue=><li key={issue.employmentId}>{issue.name} · {t(`integrity.${issue.code}`)}</li>)}</ul>:<p className="text-sm">{t('integrity.clear')}</p>}
   <form action={designateRoot} className="flex flex-wrap items-end gap-3"><input type="hidden" name="companyId" value={filter.companyId??''}/><label className="text-xs">{t('topLevel.employee')}<select name="employmentId" className="ms-2 rounded border p-2" required>{snapshot.employees.map(e=><option key={e.employmentId} value={e.employmentId}>{e.employeeCode} · {e.name}</option>)}</select></label><label className="text-xs">{t('filters.asOf')}<input name="validFrom" type="date" defaultValue={filter.asOf} className="ms-2 rounded border p-2" required/></label><select name="enabled" className="rounded border p-2 text-sm"><option value="true">{t('topLevel.designate')}</option><option value="false">{t('topLevel.end')}</option></select><button className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">{t('topLevel.save')}</button></form>
  </Card>}
  <p className="text-xs text-muted-foreground">{t.rich('legendNote',{strong:chunks=><strong>{chunks}</strong>})}</p>
 </div>;
}
