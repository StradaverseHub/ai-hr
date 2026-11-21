import {redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requireScopedLifecycleModule();const query=await searchParams;
 redirect('/lifecycle/v9?view=templates&module=probation'+(typeof query.company==='string'?'&company='+encodeURIComponent(query.company):''));
}
