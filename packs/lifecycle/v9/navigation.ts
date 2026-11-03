import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../../db/client';
import {withLifecycleTenant} from '../../../core/module-gate';
import {isModuleEnabled} from '../../../core/entitlements';
/** The existing V9 administration projection, without materialising cases or directories. */
export async function v9WorkflowNavigationAllowed(ctx:SessionContext):Promise<boolean>{
 if(!isModuleEnabled(ctx,'lifecycle'))return false;
 return withLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() or app.is_admin() and (app.onboarding_page_access() or app.lc_v9_off_access()) as allowed`);return !!row?.allowed;});
}
