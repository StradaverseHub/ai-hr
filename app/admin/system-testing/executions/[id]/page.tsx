import { testingPageRead } from '@/lib/system-testing/read-boundary';
import {notFound} from 'next/navigation';
import {settingsActionAccess} from '@/core/organisation-access';
import { requireAdmin,requireModule } from '@/lib/authz';
import { getTestingExecution } from '@/core/system-testing';
import { TestingExecutionReview } from '@/components/system-testing/execution-review';
import { feedbackBoardOpen } from '@/app/feedback/board';
export default async function TeamTestingExecutionPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{beforeRevision?:string}>}) {
  await requireAdmin(); const ctx=await requireModule('system_testing'); const {id}=await params,sp=await searchParams;
  const access=await settingsActionAccess(ctx,'systemTesting');if(!access.view)notFound();
  return <TestingExecutionReview data={await testingPageRead(() => getTestingExecution(ctx,id,{team:true,beforeRevision:sp.beforeRevision?Number(sp.beforeRevision):undefined}))} team canRequestRetest={access.edit} feedbackOpen={feedbackBoardOpen(ctx)}/>;
}
