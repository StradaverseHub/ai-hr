import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {jobArchitectureNavigationAllowedSql,ArchitectureError} from '../packs/job-architecture/service';
import {accessConfigurationNavigationAllowedSql} from './access-configuration-editor';
import {workforceNavigationAllowedSql} from './workforce-access';

/** Navigation hints share one statement snapshot. Protected pages and commands independently recheck authority. */
export function readShellNavigationAccess(ctx:SessionContext,includeWorkforce:boolean){
 if(!ctx.userId)throw new ArchitectureError('forbidden','Sign in to continue.');
 return withTenant(ctx,async tx=>{
  // The native Architecture owner allows a seat or legacy Workforce HR authority.
  // With neither candidate, skip its company scan. All positive checks stay with the owner.
  const [row]=await tx.execute<{access_configuration:boolean;workforce:boolean;architecture:boolean;onboarded:boolean}>(sql`select
   ${accessConfigurationNavigationAllowedSql} as access_configuration,
   ${includeWorkforce?workforceNavigationAllowedSql:sql`false`} as workforce,
   case when exists(select 1 from app.current_grants() where role in ('hr_admin','super_admin'))
    or exists(select 1 from public.job_architecture_seat
     where tenant_id=app.current_tenant_id() and user_id=app.current_user_id())
    then ${jobArchitectureNavigationAllowedSql} else false end as architecture,
   app.onboarding_status() as onboarded`);
  return {
   accessConfigurationAvailable:row?.access_configuration===true,
   workforceAvailable:row?.workforce===true,
   architectureAvailable:row?.architecture===true,
   onboarded:row?.onboarded===true,
  };
 });
}
