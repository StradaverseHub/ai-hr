import {getTranslations} from 'next-intl/server';
import {eraseAssistantHistoryAction} from '../../app/assistant/history-privacy-actions';
/** Render for the authenticated owner even when Assistant access has been revoked. */
export async function AssistantHistoryPrivacy({status}:{status?:string}){
 const t=await getTranslations('assistant.workspace.historyPrivacy');
 return <details className="rounded-md border p-3 text-sm">
  <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('title')}</summary>
  <div className="mt-2 space-y-3"><p className="text-xs text-muted-foreground">{t('description')}</p>
   {status==='retired'&&<p role="status" className="text-xs">{t('retired')}</p>}
   {status==='unavailable'&&<p role="alert" className="text-xs">{t('unavailable')}</p>}
   <form action={eraseAssistantHistoryAction}><button type="submit" className="min-h-11 rounded-md border px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('clear')}</button></form>
  </div>
 </details>;
}
