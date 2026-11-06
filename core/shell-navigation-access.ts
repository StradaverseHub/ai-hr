import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {AuthRequiredError} from '../lib/auth-errors';
import {accessConfigurationNavigationAllowedSql} from './access-configuration-editor';
import {workforceNavigationAllowedSql} from './workforce-access';

/** Navigation hints share one statement snapshot. Protected pages and commands independently recheck authority. */
export function readShellNavigationAccess(ctx:SessionContext,includeWorkforce:boolean){
 if(!ctx.userId)throw new AuthRequiredError();
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{access_configuration:boolean;workforce:boolean;onboarded:boolean}>(sql`select
   ${accessConfigurationNavigationAllowedSql} as access_configuration,
   ${includeWorkforce?workforceNavigationAllowedSql:sql`false`} as workforce,
   app.onboarding_status() as onboarded`);
  return {
   accessConfigurationAvailable:row?.access_configuration===true,
   workforceAvailable:row?.workforce===true,
   onboarded:row?.onboarded===true,
  };
 });
}
