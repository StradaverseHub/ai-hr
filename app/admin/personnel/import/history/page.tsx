import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {listImportAttempts} from '@/core/import-history';
import {isImportKind} from '@/lib/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportAttemptTable,ImportKindFilter,IMPORT_HISTORY_PATH} from './import-history-views';
/** Import History for personnel imports (ADR-0155). View: Workforce view for at least one listed company. */
export default async function ImportHistoryPage({searchParams}:{searchParams:Promise<{kind?:string;before?:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory');
 const params=await searchParams,kind=isImportKind(params.kind)?params.kind:undefined;
 const before=params.before&&/^[0-9a-f-]{36}$/i.test(params.before)?params.before:undefined;
 const result=await listImportAttempts(ctx,{kind,before});
 return <div className={pageWideCls}><PageHeader title={t('title')} description={t('description')} back={{href:'/admin/personnel/import',label:t('back')}}/>
  <ImportKindFilter active={kind}/>
  <ImportAttemptTable items={result.items}/>
  {result.nextCursor&&<Link className="inline-flex rounded-lg border px-4 py-2 text-sm" href={`${IMPORT_HISTORY_PATH}?${new URLSearchParams({...(kind?{kind}:{}),before:result.nextCursor})}`}>{t('older')}</Link>}
 </div>;
}
