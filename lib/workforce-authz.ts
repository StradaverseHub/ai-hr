import {redirect} from 'next/navigation';
import {getSession} from './session';
import {getScopeIds} from './scope';
import {workforceViewScope} from '../core/workforce-access';

/** Purpose-bound page scope. A role name or the ordinary directory scope cannot mint this grant. */
export async function requireWorkforceAccess() {
 const s=await getSession();
 const allowed=await workforceViewScope(s);
 if(!allowed.canOpen)redirect('/');
 return {s,scopeIds:await getScopeIds(allowed.companyIds),allowedCount:allowed.companyIds.length,companyIds:allowed.companyIds};
}
