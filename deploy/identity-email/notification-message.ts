import en from '../../messages/en.json';
import ms from '../../messages/ms.json';
import zh from '../../messages/zh.json';
import vi from '../../messages/vi.json';
import ta from '../../messages/ta.json';
import th from '../../messages/th.json';
import type { WorkflowMail } from './notifications';
const catalogues={en:en.workflowEmail,ms:ms.workflowEmail,zh:zh.workflowEmail,vi:vi.workflowEmail,ta:ta.workflowEmail,th:th.workflowEmail};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Only fixed translated copy and a validated application link leave the application. */
export function workflowEmailMessage(mail:WorkflowMail) {
  const copy=catalogues[mail.locale],label=copy.categories[mail.category];
  const subject=copy.subject.replace('{category}',label),alert=mail.action?copy.actionAlert:copy.alert;
  return {subject,text:`${alert}\n\n${copy.openApp}: ${mail.link}\n`,html:`<!doctype html><html lang="${mail.locale}"><body><p>${escape(alert)}</p><p><a href="${escape(mail.link)}">${escape(copy.openApp)}</a></p></body></html>`};
}
