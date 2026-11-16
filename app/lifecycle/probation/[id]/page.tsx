import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationCase,probationAutomationHistory} from '@/packs/probation/service';
import {CaseOverview} from '../case-overview';
export default async function Page({params}:{params:Promise<{id:string}>}){
 const {id}=await params,ctx=await requireScopedLifecycleModule();
 const view=await probationCase(ctx,id);
 // I5: the shared workflow run log; a failure to read it never blocks the case (the case itself authorised the read).
 const history=await probationAutomationHistory(ctx,id).catch(()=>undefined);
 return <CaseOverview view={view} history={history}/>;
}
