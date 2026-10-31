import {employeeMasterScheduledEmailEnabled} from '@/lib/employee-master-scheduled-email';
import {personnelFieldLabel} from '@/lib/personnel-field-label';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { masterReportCatalogue } from '@/core/employee-master-access';
import { employeeMasterOptions } from '@/core/employee-master-options';
import { getEmployeeMasterReport, masterReportRoles } from '@/core/employee-master-reports';
import { employeeMasterStarter } from '@/lib/employee-master-starters';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { PageHeader } from '@/components/ui';
import { MasterReportSchedule } from '../MasterReportSchedule';
import { employeeMasterDeliveryHistory, getEmployeeMasterSchedule } from '@/core/employee-master-schedules';
import { EmployeeMasterBuilder } from '../EmployeeMasterBuilder';
export const dynamic='force-dynamic';
export default async function EmployeeMasterPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{starter?:string}>}){
 const {s,scopeIds}=await scopedSession(),{id}=await params,{starter}=await searchParams,t=await getTranslations('employeeMasterReports'),all=await getTranslations(),roleLabels=await getTranslations('reports.permRole');
 const today=todayInKualaLumpur(),fields=await masterReportCatalogue(s,scopeIds),choices=await employeeMasterOptions(s,scopeIds),roles=await masterReportRoles(s);
 const existing=id==='new'?null:await getEmployeeMasterReport(s,scopeIds,id).catch(()=>null);if(id!=='new'&&!existing)notFound();
 const schedule=existing?await getEmployeeMasterSchedule(s,existing.id):null,history=existing?await employeeMasterDeliveryHistory(s,existing.id):[];
 const initial=existing?.spec??employeeMasterStarter(fields,scopeIds,today,starter);
 return <div className="space-y-5"><PageHeader title={existing?.name??t('newTitle')} description={t('subtitle')} back={{href:'/reports',label:t('back')}}/><EmployeeMasterBuilder initial={initial} fields={fields.map(field=>({id:field.id,label:personnelFieldLabel(field,(key,fallback)=>all.has(key)?all(key):fallback),tab:field.tab,section:field.section,type:field.type,owner:field.owner,ownerField:field.ownerField,grain:field.grain,history:field.history,scope:field.scope,report:field.report,unit:field.unit}))} companies={choices.companies} options={choices.options} roles={roles.map(role=>({value:role,label:roleLabels(role)}))} reportId={existing?.id??null} version={existing?.version??null} initialName={existing?.name??(starter?t('starter.'+starter):'')} initialDescription={existing?.description} initialRoles={existing?.sharedRoleIds} canEdit={existing?.canEdit??true} today={today}/>{existing&&<MasterReportSchedule key={existing.id+':'+existing.version+':'+(schedule?.reviewedRevision??'none')} reportId={existing.id} version={existing.version} asAt={existing.spec.asAt} canEdit={existing.canEdit} scheduledEmailEnabled={employeeMasterScheduledEmailEnabled()} schedule={schedule} history={history.map(item=>({...item,scheduledFor:item.scheduledFor.toISOString()}))}/>}</div>;
}
