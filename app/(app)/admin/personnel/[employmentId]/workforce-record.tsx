import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {workforceRecord} from '@/core/workforce-record';
import {workforceCommandAccess} from '@/core/workforce-access';
import {workforceEditor,WorkforceMaintenanceUnavailableError} from '@/core/workforce-maintenance';
import {workforceMaintenanceFields} from '@/lib/workforce-maintenance-fields';
import {WorkforceValueForm} from './workforce-value-form';
import {saveWorkforceCodeAction} from './workforce-record-actions';
import {EMPLOYEE_CODE_MAX_LEN} from '@/lib/employee-code';
import {listWorkforcePickOptions} from '@/core/read';
import {deriveEmploymentStatus} from '@/core/employment-status';
import {personnelField} from '@/lib/personnel-field-registry';
import {personnelInput} from '@/lib/personnel-form-contract';
import {personnelFieldChoices} from '@/lib/personnel-import-contract';
import {WORKFORCE_PROFILE_FIELDS} from '@/lib/workforce-record-fields';
import {formatDmy} from '@/lib/date-display';
import {dependentFieldApplies} from '@/lib/dependent-vocabulary';
import {Button,Card, PageHeader, SectionHeader,inputCls} from '@/components/ui';
import {EmployeeSwitcher} from '../employee-switcher';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK={saved:'workforceCode.saved',changed:'workforceCode.changed',denied:'workforceCode.denied',invalid:'workforceCode.invalid'} as const;
/** A separate read composition, not the HR page with its buttons hidden. None of that page's
 * compensation, statutory, private classification, documents or approval reads run for this grant. */
export async function WorkforceScopedRecord({session, employmentId, scopeIds,feedback,editFeedback}: {
 session: SessionContext; employmentId: string; scopeIds: string[]; feedback?:string;editFeedback?:string;
}) {
 if(!UUID.test(employmentId))notFound();
 const [record,employees,root,t,list,status,access,canMaintainCode,editorState]=await Promise.all([
  workforceRecord(session,employmentId),listWorkforcePickOptions(session,scopeIds),getTranslations(),
  getTranslations('people.detail'),getTranslations('people.list'),getTranslations('people.employeeStatus'),
  getTranslations('accessConfiguration'),workforceCommandAccess(session,employmentId),
  workforceEditor(session,employmentId).then(editor=>({editor,unavailable:false})).catch(error=>{
   if(error instanceof WorkforceMaintenanceUnavailableError)return {editor:null,unavailable:true};throw error;
  }),
 ]);
 if(!record)notFound();
 const {editor}=editorState;
 const feedbackKey=feedback&&Object.hasOwn(FEEDBACK,feedback)?FEEDBACK[feedback as keyof typeof FEEDBACK]:null;
 const editKey=editFeedback&&(Object.hasOwn(FEEDBACK,editFeedback)||editFeedback==='unavailable'||editFeedback==='review')?`workforceEdit.${editFeedback}`:null;
 const employment=record.employment;
 // Values and their CAS token come from the same SQL statement, never independent page reads.
 const profile=editor?.profile??record.profile;
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
  <p role="status" className="text-sm text-muted-foreground">{access(editor&&(editor.sharedMaintain||editor.employmentMaintain)?'workforceEdit.hint':canMaintainCode?'workforceCommandHint':'workforceReadOnly')}</p>
  {feedbackKey&&<p role={feedback==='saved'?'status':'alert'} className="text-sm">{access(feedbackKey)}</p>}
  {editKey&&<p role={editFeedback==='saved'?'status':'alert'} className="text-sm">{access(editKey)}</p>}
  {editorState.unavailable&&<p role="alert" className="text-sm">{access('workforceEdit.unavailable')}</p>}
  {canMaintainCode&&<Card><SectionHeader title={list('colCode')}/>
   <form action={saveWorkforceCodeAction} className="space-y-3 p-4">
    <input type="hidden" name="employmentId" value={employmentId}/>
    <input type="hidden" name="expectedCode" value={JSON.stringify(employment.employeeCode)}/>
    <label className="block text-sm" htmlFor="workforce-employee-code">{list('colCode')}</label>
    <input {...personnelInput('profile.personal_details.employeecode','record',{manualEmployeeCode:true})} id="workforce-employee-code" className={inputCls} maxLength={EMPLOYEE_CODE_MAX_LEN} pattern="[A-Za-z0-9-]{1,30}" defaultValue={employment.employeeCode??''}/>
    <p className="text-xs text-muted-foreground">{access('workforceCode.hint')}</p>
    <Button type="submit">{access('workforceCode.save')}</Button>
   </form>
  </Card>}
  {profileSections.map(section=><Card key={section.key}>
   <SectionHeader title={section.title}/>
   {editor?.sharedMaintain?<WorkforceValueForm employmentId={employmentId} kind="person" section={section.key} values={profile} editor={editor} root={root} access={access}/>:<dl className="grid gap-x-8 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
    {WORKFORCE_PROFILE_FIELDS.filter(field=>field.fieldId.startsWith(section.prefix)).map(({key,fieldId})=>{
     const field=personnelField(fieldId)!;
     const value=profile[key],choice=personnelFieldChoices(field).find(option=>option.value===value);
     const display=value==null||value===''?'—':field.type==='date'?formatDmy(value):choice&&root.has(choice.labelKey)?root(choice.labelKey):value;
     return <div key={fieldId} className="min-w-0"><dt className="text-xs text-muted-foreground">{root.has(field.labelKey)?root(field.labelKey):field.label}</dt>
      <dd className="mt-1 break-words text-sm text-foreground">{display}</dd></div>;
    })}
   </dl>}
  </Card>)}
  <Card>
   <SectionHeader title={t('employmentInfo.title')}/>
   <dl className="grid gap-x-8 gap-y-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
    {employmentFields.map(([key,label,value])=><div key={key} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm text-foreground">{value||'—'}</dd></div>)}
   </dl>
  </Card>
  {editor&&(['qualification','emergency','dependent'] as const).map(kind=>{
   const rows=editor.registers.filter(row=>row.kind===kind);
   const canMaintain=kind==='qualification'?editor.employmentMaintain:editor.sharedMaintain;
   const labelKind=kind==='dependent'?'family':kind;
   const title=kind==='qualification'?t('qualification.title'):access(kind==='dependent'?'workforceEdit.familyTitle':'workforceEdit.emergencyTitle');
   return <Card key={kind}><SectionHeader title={title}/>
    {!rows.length&&<p className="p-4 text-sm text-muted-foreground">{t(`${labelKind}.none`)}</p>}
    {rows.map(row=><details key={row.id} className="border-t p-4">
     <summary className="cursor-pointer text-sm font-medium">{String(row.values[kind==='qualification'?'qualification':'fullName']??'—')}</summary>
     {canMaintain?<WorkforceValueForm employmentId={employmentId} kind={kind} row={row} values={row.values} editor={editor} root={root} access={access}/>:<dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {workforceMaintenanceFields(kind).filter(({key})=>kind!=='dependent'||dependentFieldApplies(String(row.values.relationship??''),key)).map(({key,field})=>{
       const value=row.values[key],option=personnelFieldChoices(field).find(item=>item.value===String(value));
       const display=value==null||value===''?'—':option&&root.has(option.labelKey)?root(option.labelKey):field.type==='date'&&field.form?.widget!=='month'?formatDmy(String(value)):String(value);
       return <div key={key} className="min-w-0"><dt className="text-xs text-muted-foreground">{root.has(field.labelKey)?root(field.labelKey):field.label}</dt><dd className="mt-1 break-words text-sm">{display}</dd></div>;
      })}
     </dl>}
    </details>)}
    {canMaintain&&<details className="border-t p-4"><summary className="cursor-pointer text-sm font-medium">{t(`${labelKind}.add`)}</summary>
     <WorkforceValueForm employmentId={employmentId} kind={kind} values={kind==='emergency'?{priority:'other'}:kind==='qualification'?{isHighest:false}:{isBeneficiary:false,isDeceased:false}} editor={editor} root={root} access={access}/>
    </details>}
   </Card>;
  })}
 </div>;
}
