import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {jobArchitectureNavigationAllowedSql,ArchitectureError} from '../packs/job-architecture/service';
import {accessConfigurationNavigationAllowedSql} from './access-configuration-editor';
import {workforceNavigationAllowedSql} from './workforce-access';

/** Navigation hints share one statement snapshot. Protected pages and commands independently recheck authority. */
export function readShellNavigationAccess(ctx:SessionContext,includeWorkforce:boolean){
 if(!ctx.userId)throw new ArchitectureError('forbidden','Sign in to continue.');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{access_configuration:boolean;workforce:boolean;architecture:boolean}>(sql`select
   ${accessConfigurationNavigationAllowedSql} as access_configuration,
   ${includeWorkforce?workforceNavigationAllowedSql:sql`false`} as workforce,
   ${jobArchitectureNavigationAllowedSql} as architecture`);
  return {
   accessConfigurationAvailable:row?.access_configuration===true,
   workforceAvailable:row?.workforce===true,
   architectureAvailable:row?.architecture===true,
  };
 });
}
