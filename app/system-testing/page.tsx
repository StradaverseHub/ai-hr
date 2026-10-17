import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin,requireModule } from '@/lib/authz';
import { listTestingAssignments,listTestableModules } from '@/core/system-testing';
import type { ExecutionStatus } from '@/lib/system-testing/model';
import { TestingAssignmentList } from '@/components/system-testing/assignment-list';
import { Card,PageHeader,pageWideCls } from '@/components/ui';
export default async function MyTestingPage({ searchParams }: { searchParams:Promise<{module?:string;status?:string;functionKey?:string;category?:string;priority?:string;page?:string}> }) {
  await scopedSession(); const ctx=await requireModule('system_testing'); const sp=await searchParams,t=await getTranslations('systemTestingWorkspace');
  const data=await listTestingAssignments(ctx,{moduleCode:sp.module,functionKey:sp.functionKey,category:sp.category,priority:sp.priority,status:sp.status as ExecutionStatus|undefined,page:sp.page?Number(sp.page):1});
  return <div className={pageWideCls}><PageHeader title={t('myTesting')} description={t('ownDescription')} actions={isAdmin(ctx)?<Link className="rounded border px-3 py-2 text-sm" href="/admin/system-testing">{t('library')}</Link>:undefined}/><Card className="p-4"><TestingAssignmentList data={data} modules={listTestableModules(ctx)} selectedModule={sp.module} selectedStatus={sp.status} selectedFunction={sp.functionKey} selectedCategory={sp.category} selectedPriority={sp.priority}/></Card></div>;
}
