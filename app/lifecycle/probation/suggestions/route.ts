import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationEmployeeNameSuggestions} from '@/packs/probation/service';
import {trackerFilters} from '../tracker-filters';
export const runtime='nodejs';
export async function GET(request:Request){
 const session=await requireScopedLifecycleModule(),filters=trackerFilters(Object.fromEntries(new URL(request.url).searchParams));
 const names=await probationEmployeeNameSuggestions(session,{...filters,search:filters.search??''});
 return Response.json({names},{headers:{'cache-control':'private, no-store','vary':'Cookie'}});
}
