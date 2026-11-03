import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {Preparation} from '../preparation';
// The page's own guard, as on its sibling pages (lib/product-context/destinations.ts classifyPage reads it); Preparation repeats it.
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){await requireScopedLifecycleModule();return <Preparation kind="route" query={await searchParams}/>;}
