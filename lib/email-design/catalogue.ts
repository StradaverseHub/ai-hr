import {invitationEmailContent,recoveryEmailContent} from '../account-email-content';
import {workflowEmailSystemMessage} from '../../deploy/identity-email/notification-message';
import {employeeMasterMailMessage} from '../../deploy/identity-email/report-message';
import type {EmailKind,EmailLocale} from './model';
export function sampleEmailSystem(kind:EmailKind,locale:EmailLocale){
 const link='https://example.com/aihr-preview';
 if(kind==='invitation')return {...invitationEmailContent('SAMPLE',link,locale),link};
 if(kind==='recovery')return {...recoveryEmailContent(link,locale),link};
 if(kind==='employee_master_report')return employeeMasterMailMessage(locale);
 const category=kind.startsWith('workflow.')?kind.slice(9) as 'leave':kind==='assessment_reminder'?'performance':'attendance';
 return {...workflowEmailSystemMessage({category,locale,link,action:true,messageId:'<preview@example.com>',...(kind==='assessment_reminder'?{assessmentTasks:[{key:'own_results' as const,count:1,closesAt:null}]}:{})}),link};
}
