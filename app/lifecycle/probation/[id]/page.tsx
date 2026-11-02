import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationCase} from '@/packs/probation/service';
import {CaseOverview} from '../case-overview';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <CaseOverview view={await probationCase(await requireScopedLifecycleModule(),id)}/>;}
