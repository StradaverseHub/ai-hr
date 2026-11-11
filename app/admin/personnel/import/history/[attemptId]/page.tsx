import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getImportAttempt} from '@/core/import-history';
import {importKindRevertible} from '@/core/import-history-handlers';
import {activeEmployeeImportRevertJob} from '@/core/employee-import-revert-job';
import {activeMovementImportRevertJob} from '@/core/movement-import-revert-job';
import {informationImportLog} from '@/core/information-correction-import';
import {importAttemptStatus} from '@/lib/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportAttemptEvents,ImportAttemptItems,ImportAttemptSummary,InformationImportLog,IMPORT_HISTORY_PATH} from '../import-history-views';
import {ImportRevertControl} from '../import-revert-control';
/** One import attempt (its Import Log): file, outcome, per-row results, audit trail and (when allowed) Revert. */
export default async function ImportAttemptPage({params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory');
 const{attemptId}=await params,item=await getImportAttempt(ctx,attemptId);if(!item)notFound();
 const status=importAttemptStatus(item.plan,item.events);
 const revertible=(status==='succeeded'||status==='partial')&&importKindRevertible(item.kind);
 // A background revert of this attempt (an employee import or a movement import) that the signed-in user started and
 // that is still running.
 const activeRevert=!revertible?null:item.kind==='employee_full'?await activeEmployeeImportRevertJob(ctx,item.id):item.kind==='movement'?await activeMovementImportRevertJob(ctx,item.id):null;
 return <div className={pageWideCls}><PageHeader title={item.sourceName} description={t('referenceLabel',{reference:item.id})} back={{href:`${IMPORT_HISTORY_PATH}?kind=${item.kind}`,label:t('title')}}/>
  <ImportAttemptSummary item={item}/>
  {/* ccd3a65c — an Information-Only Correction file lists every row, including rows refused at the check. */}
  {item.kind==='information_correction'?<InformationImportLog rows={await informationImportLog(ctx,item)}/>:<ImportAttemptItems item={item}/>}
  <ImportAttemptEvents item={item}/>
  {revertible&&(item.canRevert?<ImportRevertControl attemptId={item.id} activeJobId={activeRevert?.id??null}/>:<p className="rounded-xl border p-5 text-sm text-muted-foreground">{t('revert.noPermission')}</p>)}
 </div>;
}
