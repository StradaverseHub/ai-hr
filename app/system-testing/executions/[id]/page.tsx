import { testingPageRead } from '@/lib/system-testing/read-boundary';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getTestingExecution } from '@/core/system-testing';
import { TestingExecutionReview } from '@/components/system-testing/execution-review';
import { feedbackBoardOpen } from '@/app/feedback/board';
export default async function MyTestingExecutionPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{beforeRevision?:string}>}) {
  await scopedSession(); const ctx=await requireModule('system_testing'); const {id}=await params,sp=await searchParams;
  return <TestingExecutionReview data={await testingPageRead(() => getTestingExecution(ctx,id,{beforeRevision:sp.beforeRevision?Number(sp.beforeRevision):undefined}))} feedbackOpen={feedbackBoardOpen(ctx)}/>;
}
