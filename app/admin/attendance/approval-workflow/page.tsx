import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {listAttendanceWorkflows,listRetiredAttendanceWorkflows,listAttendanceWorkflowSettings,attendanceApplicationFilterOptions} from '@/packs/attendance/service';
import {PageHeader,Card,pageWideCls,tableWrapCls,tbodyCls,thCls} from '@/components/ui';
import {ATTENDANCE_APPLICATION_TYPES} from '@/lib/attendance-workflow';
import {WorkflowRetirementControls} from './retirement-controls';
import {RoutingSwitch} from './workflow-form';
import {workflowRoot,type WorkflowQuery} from './navigation';
export default async function AttendanceWorkflowPage({searchParams}:{searchParams:Promise<WorkflowQuery>}){
 const {s,scopeIds,allowedCompanyIds}=await scopedAdmin(),t=await getTranslations('attendanceWorkflow'),query=await searchParams;
 const applicationType=query.applicationType??'irregularity';
 if(applicationType!=='irregularity'&&applicationType!=='self_overtime')notFound();
 if(query.companyId!==undefined&&(typeof query.companyId!=='string'||!(allowedCompanyIds??scopeIds).includes(query.companyId)))notFound();
 const ids=typeof query.companyId==='string'?[query.companyId]:scopeIds;
 const [rows,settings,options,retired]=await Promise.all([listAttendanceWorkflows(s,ids),listAttendanceWorkflowSettings(s,allowedCompanyIds??scopeIds),attendanceApplicationFilterOptions(s,allowedCompanyIds??scopeIds),listRetiredAttendanceWorkflows(s,ids)]);
 const names=(ids:string[])=>ids.map(id=>options.companies.find(c=>c.id===id)?.name??t('unavailable',{value:id})).join(', ');
 const workflows=rows.filter(row=>row.applicationType===applicationType&&(!query.companyId||row.companyIds.includes(String(query.companyId))));
 return <div className={pageWideCls+' space-y-5'}>
  <PageHeader title={t('title')} description={t('sharedCompanyHelp')} back={{href:'/admin/attendance/settings',label:t('backSettings')}}/>
  <nav aria-label={t('applicationType')} className="flex flex-wrap gap-3 border-b border-border pb-3">{ATTENDANCE_APPLICATION_TYPES.map(type=><Link key={type} href={workflowRoot+'?applicationType='+type} aria-current={type===applicationType?'page':undefined} className={'rounded-md px-4 py-2 text-sm font-medium '+(type===applicationType?'bg-primary text-primary-foreground':'border border-border')}>{t('types.'+type)}</Link>)}</nav>
  {(query.notice==='deleted'||query.notice==='archived')&&<p role="status">{t(query.notice==='archived'?'v4.archived':'v4.deleted')}</p>}
  <div className="flex flex-wrap justify-between gap-3"><h2 className="text-lg font-semibold">{t('types.'+applicationType)}</h2><Link className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" href={workflowRoot+'/new?applicationType='+applicationType}>{t('create')}</Link></div>
  <div className={tableWrapCls}><table className="w-full text-left text-sm"><thead><tr>{['code','name','company','stages','priority','status','actions'].map(key=><th key={key} className={thCls}>{t(key)}</th>)}</tr></thead><tbody className={tbodyCls}>{workflows.map(row=><tr key={row.id}><td className="p-3">{row.code}</td><td className="p-3">{row.name}</td><td className="max-w-sm p-3">{row.allCompanies?t('allCompany'):names(row.companyIds)}</td><td className="p-3">{row.stages.length}</td><td className="p-3">{row.priority}</td><td className="p-3">{t(row.active?'active':'inactive')}</td><td className="p-3"><div className="flex flex-wrap gap-3"><Link className="text-primary underline" href={workflowRoot+'/'+row.lineageId}>{t('view')}</Link><Link className="text-primary underline" href={workflowRoot+'/'+row.lineageId+'/edit'}>{t('edit')}</Link><WorkflowRetirementControls lineageId={row.lineageId} version={row.version} name={row.name} used={row.used} company={row.allCompanies?t('allCompany'):names(row.companyIds)}/></div></td></tr>)}{!workflows.length&&<tr><td colSpan={7} className="p-5 text-muted-foreground">{t('empty')}</td></tr>}</tbody></table></div>
  <Card className="p-4"><details><summary className="cursor-pointer text-sm font-medium">{t('routingHelp')}</summary><ul className="mt-3 divide-y divide-border">{options.companies.map(company=>{const enabled=settings.some(setting=>setting.companyId===company.id&&setting.applicationType===applicationType&&setting.enabled);return <li key={company.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><span>{company.name} · {t(enabled?'routingEnabled':'legacyRouting')}</span><RoutingSwitch companyId={company.id} type={applicationType} enabled={enabled}/></li>;})}</ul></details></Card>
  {!!retired.filter(row=>row.applicationType===applicationType&&row.used).length&&<details className="rounded-xl border border-border p-4"><summary>{t('v4.archivedList')}</summary><ul>{retired.filter(row=>row.applicationType===applicationType&&row.used).map(row=><li key={row.id} className="flex justify-between gap-3 py-3"><Link className="text-primary underline" href={workflowRoot+'/'+row.lineageId}>{row.code} · {row.name}</Link><WorkflowRetirementControls retired lineageId={row.lineageId} version={row.version} name={row.name} used={row.used} company={row.allCompanies?t('allCompany'):names(row.companyIds)}/></li>)}</ul></details>}
 </div>;
}
