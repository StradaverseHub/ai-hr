import {renderEmailDesign} from '../../lib/email-design/render';
import {emailDesignEnvelope,type EmailKind} from '../../lib/email-design/model';
import en from '../../messages/en.json';
import ms from '../../messages/ms.json';
import zh from '../../messages/zh.json';
import vi from '../../messages/vi.json';
import ta from '../../messages/ta.json';
import th from '../../messages/th.json';
import type { WorkflowMail } from './notifications';
import {attendanceCcMessage} from '../../lib/attendance-cc-mail';
import {assessmentReminderMessage} from '../../lib/assessment-reminder-message';
const catalogues={en:en.workflowEmail,ms:ms.workflowEmail,zh:zh.workflowEmail,vi:vi.workflowEmail,ta:ta.workflowEmail,th:th.workflowEmail};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Fixed alerts or validated assessment summaries; the isolated service owns delivery. */
export function workflowEmailSystemMessage(mail:WorkflowMail,openingInDesign=false) {
  const copy=catalogues[mail.locale],label=copy.categories[mail.category];
  if(mail.attendanceCc){
    const message=attendanceCcMessage.parse(mail.attendanceCc),labels=copy.attendanceCc;
    const date=new Intl.DateTimeFormat(mail.locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(message.occurredAt));
    const lines=[`${labels.reference}: ${message.reference}`,`${labels.applicant}: ${message.applicant}`,`${labels.level}: ${message.level}`,`${labels.action}: ${labels.actions[message.action]}`,`${labels.actor}: ${message.actor}`,`${labels.when}: ${date}`,labels.notice];
    return{subject:copy.subject.replace('{category}',label),text:lines.join('\n')+`\n\n${copy.openApp}: ${mail.link}\n`,html:`<!doctype html><html lang="${mail.locale}"><body>${lines.map(line=>`<p>${escape(line)}</p>`).join('')}<p><a href="${escape(mail.link)}">${escape(copy.openApp)}</a></p></body></html>`};
  }
  if(mail.assessmentTasks){
    return assessmentReminderMessage({tasks:mail.assessmentTasks,words:mail.assessmentWords},mail.locale,mail.link,openingInDesign);
  }
  const subject=copy.subject.replace('{category}',label),alert=mail.action?copy.actionAlert:copy.alert;
  return {subject,text:`${alert}\n\n${copy.openApp}: ${mail.link}\n`,html:`<!doctype html><html lang="${mail.locale}"><body><p>${escape(alert)}</p><p><a href="${escape(mail.link)}">${escape(copy.openApp)}</a></p></body></html>`};
}

/** The isolated sender validates documents again; raw administrator HTML never crosses IPC. */
export function workflowEmailMessage(mail:WorkflowMail){
 const kind:EmailKind=mail.attendanceCc?'attendance_cc':mail.assessmentTasks?'assessment_reminder':`workflow.${mail.category}`;
 const design=mail.design?emailDesignEnvelope.parse(mail.design):null;
 if(design&&(design.kind!==kind||design.locale!==mail.locale))throw Error('Email design binding changed.');
 const system=workflowEmailSystemMessage(mail,kind==='assessment_reminder'&&!!design?.document);
 return renderEmailDesign(design?.document??null,kind,mail.locale,{subject:system.subject,text:system.text,link:mail.link},{...design?.data,category:mail.category});
}
