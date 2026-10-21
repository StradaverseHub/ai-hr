import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {workforceRecord} from '@/core/workforce-record';
import {workforceCommandAccess} from '@/core/workforce-access';
import {saveWorkforceCodeAction} from './workforce-record-actions';
import {EMPLOYEE_CODE_MAX_LEN} from '@/lib/employee-code';
import {listWorkforcePickOptions} from '@/core/read';
import {deriveEmploymentStatus} from '@/core/employment-status';
import {personnelField} from '@/lib/personnel-field-registry';
import {personnelFieldChoices} from '@/lib/personnel-import-contract';
import {WORKFORCE_PROFILE_FIELDS} from '@/lib/workforce-record-fields';
import {formatDmy} from '@/lib/date-display';
import {Button,Card, PageHeader, SectionHeader,inputCls} from '@/components/ui';
import {EmployeeSwitcher} from '../employee-switcher';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK={saved:'workforceCode.saved',changed:'workforceCode.changed',denied:'workforceCode.denied',invalid:'workforceCode.invalid'} as const;
/** A separate read composition, not the HR page with its buttons hidden. None of that page's
 * compensation, statutory, private classification, documents or approval reads run for this grant. */
export async function WorkforceScopedRecord({session, employmentId, scopeIds,feedback}: {
 session: SessionContext; employmentId: string; scopeIds: string[]; feedback?:string;
}) {
 if(!UUID.test(employmentId))notFound();
 const [record,employees,root,t,list,status,access,canMaintainCode]=await Promise.all([
  workforceRecord(session,employmentId),listWorkforcePickOptions(session,scopeIds),getTranslations(),
  getTranslations('people.detail'),getTranslations('people.list'),getTranslations('people.employeeStatus'),
  getTranslations('accessConfiguration'),workforceCommandAccess(session,employmentId),
 ]);
 if(!record)notFound();
 const feedbackKey=feedback&&Object.hasOwn(FEEDBACK,feedback)?FEEDBACK[feedback as keyof typeof FEEDBACK]:null;
 const employment=record.employment;
 const profileSections=[{key:'personal',title:t('personalDetails'),prefix:'profile.personal_details.'},
  {key:'contact',title:t('contactAddressTitle'),prefix:'profile.contact_and_permanent_address.'},
  {key:'correspondence',title:t('correspondenceAddressTitle'),prefix:'profile.correspondence_address.'}];
 const employmentFields=[
  ['code',list('colCode'),employment.employeeCode], ['company',list('colCompany'),employment.company],
  ['department',list('colDepartment'),employment.department], ['position',list('colPosition'),employment.position],
  ['grade',list('colJobGrade'),employment.jobGrade], ['unit',list('colBusinessUnit'),employment.businessUnit],
  ['costCenter',list('colCostCenter'),employment.costCenter], ['location',list('colWorkLocation'),employment.workLocation],
  ['reporting',list('colReportingTo'),employment.reportingTo], ['hired',list('colHired'),formatDmy(employment.hiredOn)],
  ['joined',list('colJoinDate'),formatDmy(employment.joinDate)],
  ['confirmation',list('colConfirmationDate'),formatDmy(employment.finalConfirmationDate??employment.confirmationDate)],
  ['status',list('colStatus'),status(deriveEmploymentStatus(employment))],
 ];
 return <div className="space-y-6">
  <Link href="/admin/personnel" className="text-sm text-muted-foreground hover:underline">{t('backToPersonnelAdmin')}</Link>
  <PageHeader title={employment.name} actions={<EmployeeSwitcher employees={employees}/>}/>
  <p role="status" className="text-sm text-muted-foreground">{access(canMaintainCode?'workforceCommandHint':'workforceReadOnly')}</p>
  {feedbackKey&&<p role={feedback==='saved'?'status':'alert'} className="text-sm">{access(feedbackKey)}</p>}
  {canMaintainCode&&<Card><SectionHeader title={list('colCode')}/>
   <form action={saveWorkforceCodeAction} className="space-y-3 p-4">
    <input type="hidden" name="employmentId" value={employmentId}/>
    <input type="hidden" name="expectedCode" value={JSON.stringify(employment.employeeCode)}/>
    <label className="block text-sm" htmlFor="workforce-employee-code">{list('colCode')}</label>
    <input id="workforce-employee-code" name="employeeCode" className={inputCls} required maxLength={EMPLOYEE_CODE_MAX_LEN} pattern="[A-Za-z0-9-]{1,30}" defaultValue={employment.employeeCode??''}/>
    <p className="text-xs text-muted-foreground">{access('workforceCode.hint')}</p>
    <Button type="submit">{access('workforceCode.save')}</Button>
   </form>
  </Card>}
  {profileSections.map(section=><Card key={section.key}>
   <SectionHeader title={section.title}/>
   <dl className="grid gap-x-8 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
    {WORKFORCE_PROFILE_FIELDS.filter(field=>field.fieldId.startsWith(section.prefix)).map(({key,fieldId})=>{
     const field=personnelField(fieldId)!;
     const value=record.profile[key],choice=personnelFieldChoices(field).find(option=>option.value===value);
     const display=value==null||value===''?'—':field.type==='date'?formatDmy(value):choice&&root.has(choice.labelKey)?root(choice.labelKey):value;
     return <div key={fieldId} className="min-w-0"><dt className="text-xs text-muted-foreground">{root.has(field.labelKey)?root(field.labelKey):field.label}</dt>
      <dd className="mt-1 break-words text-sm text-foreground">{display}</dd></div>;
    })}
   </dl>
  </Card>)}
  <Card>
   <SectionHeader title={t('employmentInfo.title')}/>
   <dl className="grid gap-x-8 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
    {employmentFields.map(([key,label,value])=><div key={key} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm text-foreground">{value||'—'}</dd></div>)}
   </dl>
  </Card>
 </div>;
}
