import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {assertModuleEnabled} from './entitlements';
import {ProbationError} from '../lib/probation-model';
import type {ProbationForm} from '../lib/probation-form';
/** Version selection is a read-only projection. Saving still creates the next native version. */
export function probationFormVersions(ctx:SessionContext,companyId:string){return withScopedLifecycleTenant(ctx,async tx=>{
 z.uuid().parse(companyId);if(ctx.entitlementsExempt===undefined)assertModuleEnabled(ctx,'lifecycle',companyId);
 const[access]=await tx.execute<{allowed:boolean}>(sql`select app.probation_config_admin(${companyId}::uuid) as allowed`);if(!access?.allowed)throw new ProbationError('forbidden','Named probation preparer access is required.');
 const rows=await tx.execute<{id:string;version:number;state:'draft'|'published'|'retired';retirementReason:string|null;data:ProbationForm}>(sql`select id,version,state,retirement_reason as "retirementReason",data from probation_configuration where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='form' order by version desc limit 1001`);
 return{versions:Array.from(rows).slice(0,1000),truncated:rows.length>1000};
});}
