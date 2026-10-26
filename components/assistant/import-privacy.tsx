import {getTranslations} from 'next-intl/server';
import {eraseImportPreparationHistoryAction} from '../../app/assistant/import-privacy-actions';

/** No private history, grant or employee metadata is needed to render this self-erasure control. */
export async function ImportPreparationPrivacy({status}:{status?:string}){
 const t=await getTranslations('assistant.workspace.importPrivacy');
 return <details className="rounded-md border p-3 text-sm">
  <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t('title')}</summary>
  <div className="mt-2 space-y-3"><p className="text-xs text-muted-foreground">{t('description')}</p>
   {status==='erased'&&<p role="status" className="text-xs">{t('erased')}</p>}
   {status==='unavailable'&&<p role="alert" className="text-xs">{t('unavailable')}</p>}
   <form action={eraseImportPreparationHistoryAction}><button type="submit" className="min-h-11 rounded-md border px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('clear')}</button></form>
  </div>
 </details>;
}
