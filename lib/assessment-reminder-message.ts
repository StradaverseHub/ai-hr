import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import {assessmentReminderMailSchema,type AssessmentReminderTask} from './assessment-reminder-mail';
import type {NotificationEmailLocale} from './notification-email-model';
import {renderEmailDesign} from './email-design/render';
import {emailDesignEnvelope,type EmailDesignEnvelope} from './email-design/model';
const catalogues={en:en.workflowEmail,ms:ms.workflowEmail,zh:zh.workflowEmail,vi:vi.workflowEmail,ta:ta.workflowEmail,th:th.workflowEmail};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Code-owned summary only. The final preview/sender renderer wraps this once. */
export function assessmentReminderSystemMessage(mail:unknown,locale:NotificationEmailLocale,link:string,openingInDesign=false){
 const copy=catalogues[locale];
    const parsed=assessmentReminderMailSchema.parse(mail),tasks=parsed.tasks,c=copy.assessmentReminder;
    const groups=['feedback','team','own','lead'] as const;
    const group=(task:AssessmentReminderTask)=>task.key==='feedback'?'feedback':task.key.startsWith('team_')?'team':task.key.startsWith('own_')?'own':'lead';
    const sections=groups.flatMap(key=>{
      const mine=tasks.filter(task=>group(task)===key);if(!mine.length)return [];
      const lines=mine.map(task=>{
        const parts=[c.tasks[task.key],c.count.replace('{count}',String(task.count))];
        if(task.people?.length)parts.push(task.people.join(', ')+(task.count>task.people.length?' '+c.more.replace('{count}',String(task.count-task.people.length)):''));
        if(task.closesAt)parts.push(c.deadline.replace('{date}',new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',year:'numeric'}).format(new Date(task.closesAt))));
        return parts.join(' · ');
      });
      return [{label:c.groups[key],lines}];
    });
    const subject=parsed.words?.subject??c.subject.replace('{count}',String(tasks.length)),opening=parsed.words?.opening??c.opening;
    return {subject,text:`${openingInDesign?'':opening+'\n\n'}${sections.map(s=>s.label+'\n'+s.lines.join('\n')).join('\n\n')}\n\n${copy.openApp}: ${link}\n`,
      html:`<!doctype html><html lang="${locale}"><body>${openingInDesign?'':'<p>'+escape(opening)+'</p>'}${sections.map(s=>'<h2>'+escape(s.label)+'</h2><ul>'+s.lines.map(line=>'<li>'+escape(line)+'</li>').join('')+'</ul>').join('')}<p><a href="${escape(link)}">${escape(copy.openApp)}</a></p></body></html>`};
}

/** The exact final renderer for administrator previews and recipient-bound delivery. */
export function assessmentReminderMessage(mail:unknown,locale:NotificationEmailLocale,link:string,rawDesign?:EmailDesignEnvelope|null){
 const design=rawDesign?emailDesignEnvelope.parse(rawDesign):null;
 if(design&&(design.kind!=='assessment_reminder'||design.locale!==locale))throw Error('Email design binding changed.');
 const parsed=assessmentReminderMailSchema.parse(mail);
 // A localized document is the wording owner; prepared English words are never its fallback.
 const system=assessmentReminderSystemMessage(design?{...parsed,words:null}:parsed,locale,link,!!design?.document);
 return renderEmailDesign(design?.document??null,'assessment_reminder',locale,{subject:system.subject,text:system.text,link},design?.data);
}
