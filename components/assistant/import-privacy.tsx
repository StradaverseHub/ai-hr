import {getTranslations} from 'next-intl/server';
import {eraseImportPreparationHistoryAction} from '../../app/(app)/assistant/import-privacy-actions';
import {OwnClearForm} from './own-clear';

/** No private history, grant or employee metadata is needed to render this self-erasure control. It asks
 * first; the outcome sits OUTSIDE the collapsible so the post-redirect page shows it. */
export async function ImportPreparationPrivacy({status}:{status?:string}){
 const t=await getTranslations('assistant.workspace.importPrivacy');
 return <div className="space-y-2">
  {status==='erased'&&<p role="status" className="text-xs">{t('erased')}</p>}
  {status==='unavailable'&&<p role="alert" className="text-xs">{t('unavailable')}</p>}
  <details className="rounded-md border p-3 text-sm">
  <summary className="flex min-h-11 cursor-pointer items-center font-medium">{t('title')}</summary>
  <div className="mt-2 space-y-3"><p className="text-xs text-muted-foreground">{t('description')}</p>
   <OwnClearForm kind="importHistory" action={eraseImportPreparationHistoryAction} label={t('clear')}/>
  </div>
  </details>
 </div>;
}
