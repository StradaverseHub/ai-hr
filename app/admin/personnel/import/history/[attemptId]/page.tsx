import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getImportAttempt} from '@/core/import-history';
import {importKindRevertible} from '@/core/import-history-handlers';
import {importAttemptStatus} from '@/lib/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportAttemptEvents,ImportAttemptItems,ImportAttemptSummary,IMPORT_HISTORY_PATH} from '../import-history-views';
import {ImportRevertControl} from '../import-revert-control';
/** One import attempt: file, outcome, per-employee before/after, audit trail and (when allowed) Revert. */
export default async function ImportAttemptPage({params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory');
 const{attemptId}=await params,item=await getImportAttempt(ctx,attemptId);if(!item)notFound();
 const status=importAttemptStatus(item.plan,item.events);
 const revertible=(status==='succeeded'||status==='partial')&&importKindRevertible(item.kind);
 return <div className={pageWideCls}><PageHeader title={item.sourceName} description={t('referenceLabel',{reference:item.id})} back={{href:`${IMPORT_HISTORY_PATH}?kind=${item.kind}`,label:t('title')}}/>
  <ImportAttemptSummary item={item}/>
  <ImportAttemptItems item={item}/>
  <ImportAttemptEvents item={item}/>
  {revertible&&(item.canRevert?<ImportRevertControl attemptId={item.id}/>:<p className="rounded-xl border p-5 text-sm text-muted-foreground">{t('revert.noPermission')}</p>)}
 </div>;
}
