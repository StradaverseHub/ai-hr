import {getTranslations} from 'next-intl/server';
import {eraseAssistantHistoryAction} from '../../app/(app)/assistant/history-privacy-actions';
import {ConfirmSubmit} from '../ui/confirm-submit';
/** Render for the authenticated owner even when Assistant access has been revoked. Clearing is
 * irreversible, so it asks first (shared confirm dialog). The outcome sits OUTSIDE the collapsible so
 * the post-redirect page, which renders it collapsed, still shows that it worked. */
export async function AssistantHistoryPrivacy({status}:{status?:string}){
 const t=await getTranslations('assistant.workspace.historyPrivacy');
 return <div className="space-y-2">
  {status==='retired'&&<p role="status" className="text-xs">{t('retired')}</p>}
  {status==='unavailable'&&<p role="alert" className="text-xs">{t('unavailable')}</p>}
  <details className="rounded-md border p-3 text-sm">
  <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('title')}</summary>
  <div className="mt-2 space-y-3"><p className="text-xs text-muted-foreground">{t('description')}</p>
   <form action={eraseAssistantHistoryAction}><ConfirmSubmit variant="outline" confirmVariant="destructive" title={t('confirmTitle')} description={t('confirmBody')} confirmLabel={t('confirmClear')} cancelLabel={t('keep')} className="min-h-11 px-3 py-2 text-xs">{t('clear')}</ConfirmSubmit></form>
  </div>
  </details>
 </div>;
}
