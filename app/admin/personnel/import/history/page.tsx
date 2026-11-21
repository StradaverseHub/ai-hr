import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {listImportHistory} from '@/core/import-history';
import {isImportHistoryKind} from '@/lib/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportHistoryTable,ImportKindFilter,IMPORT_HISTORY_PATH} from './import-history-views';
/** Import History for personnel imports (ADR-0155, ccd3a65c). Attempts: Workforce view for at least one listed
 * company (RLS). Section runs: filtered read-side by the viewer's company access (core/import-history). */
export default async function ImportHistoryPage({searchParams}:{searchParams:Promise<{kind?:string;before?:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory');
 const params=await searchParams,kind=isImportHistoryKind(params.kind)?params.kind:undefined;
 const before=params.before&&/^[ar]\.[0-9a-f-]{36}$/i.test(params.before)?params.before:undefined;
 const result=await listImportHistory(ctx,{kind,before});
 return <div className={pageWideCls}><PageHeader title={t('title')} description={t('listDescription')} back={{href:'/admin/personnel/import',label:t('backToImport')}}/>
  <ImportKindFilter active={kind}/>
  <ImportHistoryTable items={result.items}/>
  {result.nextCursor&&<Link className="inline-flex rounded-lg border px-4 py-2 text-sm" href={`${IMPORT_HISTORY_PATH}?${new URLSearchParams({...(kind?{kind}:{}),before:result.nextCursor})}`}>{t('older')}</Link>}
 </div>;
}
