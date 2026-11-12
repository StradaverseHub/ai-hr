import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {AuthRequiredError} from '../lib/auth-errors';
import {accessConfigurationNavigationAllowedSql} from './access-configuration-editor';
import {workforceNavigationAllowedSql} from './workforce-access';

/** Navigation hints share one statement snapshot. Protected pages and commands independently recheck authority.
 * 82748f92: `includePeopleGeneral` adds the People › Settings General hint (app.people_general_can_configure(), the
 * same function the General page and its card use) to the SAME statement, so the command bar never offers General
 * to an administrator its page would send home. No extra round trip and no Access lock (plain catalogue read). */
export function readShellNavigationAccess(ctx:SessionContext,includeWorkforce:boolean,includePeopleGeneral=false){
 if(!ctx.userId)throw new AuthRequiredError();
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{access_configuration:boolean;workforce:boolean;onboarded:boolean;people_general:boolean}>(sql`select
   ${accessConfigurationNavigationAllowedSql} as access_configuration,
   ${includeWorkforce?workforceNavigationAllowedSql:sql`false`} as workforce,
   app.onboarding_status() as onboarded,
   ${includePeopleGeneral?sql`app.people_general_can_configure()`:sql`false`} as people_general`);
  return {
   accessConfigurationAvailable:row?.access_configuration===true,
   workforceAvailable:row?.workforce===true,
   onboarded:row?.onboarded===true,
   ...(includePeopleGeneral?{peopleGeneralConfigurable:row?.people_general===true}:{}),
  };
 });
}
