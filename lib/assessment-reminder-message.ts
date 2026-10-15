import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import {assessmentReminderMailSchema,type AssessmentReminderTask} from './assessment-reminder-mail';
import type {NotificationEmailLocale} from './notification-email-model';
const catalogues={en:en.workflowEmail,ms:ms.workflowEmail,zh:zh.workflowEmail,vi:vi.workflowEmail,ta:ta.workflowEmail,th:th.workflowEmail};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Shared renderer for the administrator preview and the isolated mail worker. */
export function assessmentReminderMessage(mail:unknown,locale:NotificationEmailLocale,link:string){
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
    return {subject,text:`${opening}\n\n${sections.map(s=>s.label+'\n'+s.lines.join('\n')).join('\n\n')}\n\n${copy.openApp}: ${link}\n`,
      html:`<!doctype html><html lang="${locale}"><body><p>${escape(opening)}</p>${sections.map(s=>'<h2>'+escape(s.label)+'</h2><ul>'+s.lines.map(line=>'<li>'+escape(line)+'</li>').join('')+'</ul>').join('')}<p><a href="${escape(link)}">${escape(copy.openApp)}</a></p></body></html>`};
}
