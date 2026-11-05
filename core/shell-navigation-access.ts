import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {jobArchitectureNavigationAllowedSql,ArchitectureError} from '../packs/job-architecture/service';
import {accessConfigurationNavigationAllowedSql} from './access-configuration-editor';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {workforceNavigationAllowedSql} from './workforce-access';

/** Fresh navigation hints share one Access read lock and one connection. Page and command owners recheck authority. */
export function readShellNavigationAccess(ctx:SessionContext,includeWorkforce:boolean){
 if(!ctx.userId)throw new ArchitectureError('forbidden','Sign in to continue.');
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
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
