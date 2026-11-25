/** ADR 0181: the scheduled rebuild-and-compare of precomputed employment visibility (migration 7240,
 * docs/adr/0181-addendum-precomputed-employment-visibility.md section 7).
 *
 * OWNER CONNECTION. Two passes:
 *  * rebuild: every tenant that is stale (a whole-tenant change above the inline limit) or past its date window is
 *    rebuilt with app.access_visible_employment_refresh(tenant, NULL, true, NULL). Cheap to run often.
 *  * verify: app.access_visible_employment_verify recomputes the reach, the department closure and the company closure
 *    from scratch and compares them with the maintained rows. Any difference marks the tenant untrusted in the
 *    database, so its reads fall back to the legacy walk until an operator re-trusts it
 *    (app.access_visible_employment_retrust).
 *
 * Output: counts per tenant only when that tenant differs (the operator needs the id to re-trust it), and one summary
 * line. No person, user, employment or HR value. */
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';

export type AccessVisibleEmploymentVerification={windowRefreshed:boolean;closureDifferences:number;departmentsMissing:number;departmentsExtra:number;reachMissing:number;reachExtra:number;trusted:boolean};
export type AccessVisibleEmploymentCheck={tenantsChecked:number;tenantsFailed:number;tenantsDiffering:number;tenantsUntrusted:number;tenantsRebuilt:number};

export const visibleEmploymentDifferences=(v:AccessVisibleEmploymentVerification)=>v.closureDifferences+v.departmentsMissing+v.departmentsExtra+v.reachMissing+v.reachExtra;

export async function verifyAccessVisibleEmploymentTenant(owner:Db,tenantId:string):Promise<AccessVisibleEmploymentVerification>{
 const [row]=await owner.transaction(tx=>tx.execute<{window_refreshed:boolean;closure_differences:number;departments_missing:number;departments_extra:number;reach_missing:number;reach_extra:number;trusted:boolean}>(
  sql`select * from app.access_visible_employment_verify(${tenantId}::uuid)`));
 return{windowRefreshed:row.window_refreshed,closureDifferences:Number(row.closure_differences),departmentsMissing:Number(row.departments_missing),
  departmentsExtra:Number(row.departments_extra),reachMissing:Number(row.reach_missing),reachExtra:Number(row.reach_extra),trusted:row.trusted};
}

/** Rebuild the tenants that are stale or past their window; returns how many were rebuilt. */
export async function rebuildDueAccessVisibleEmployment(owner:Db,log:(line:string)=>void=()=>{}):Promise<{rebuilt:number;failed:number}>{
 const due=Array.from(await owner.execute<{id:string}>(sql`select s.tenant_id::text as id from access_employment_state s
  where s.stale or s.computed_for is null or s.computed_for>(now() at time zone 'Asia/Kuala_Lumpur')::date
   or (s.valid_until is not null and (now() at time zone 'Asia/Kuala_Lumpur')::date>=s.valid_until) order by 1`));
 let rebuilt=0,failed=0;
 for(const {id} of due){
  try{await owner.transaction(tx=>tx.execute(sql`select app.access_visible_employment_refresh(${id}::uuid,null,true,null)`));rebuilt++;}
  catch(error){failed++;log(`access-visible-employment could not rebuild tenant=${id}: ${(error as Error).name}`);}
 }
 return{rebuilt,failed};
}

export async function accessVisibleEmploymentCheck(owner:Db,log:(line:string)=>void=()=>{},opts:{verify:boolean}={verify:true}):Promise<AccessVisibleEmploymentCheck>{
 const out:AccessVisibleEmploymentCheck={tenantsChecked:0,tenantsFailed:0,tenantsDiffering:0,tenantsUntrusted:0,tenantsRebuilt:0};
 const rebuild=await rebuildDueAccessVisibleEmployment(owner,log);
 out.tenantsRebuilt=rebuild.rebuilt;out.tenantsFailed+=rebuild.failed;
 if(!opts.verify)return out;
 const tenants=Array.from(await owner.execute<{id:string}>(sql`select id::text as id from tenant order by 1`));
 for(const {id} of tenants){
  try{
   const v=await verifyAccessVisibleEmploymentTenant(owner,id);
   out.tenantsChecked++;
   if(!v.trusted)out.tenantsUntrusted++;
   if(visibleEmploymentDifferences(v)>0){
    out.tenantsDiffering++;
    log(`access-visible-employment DIFFERENCE tenant=${id} closure=${v.closureDifferences} departments_missing=${v.departmentsMissing} departments_extra=${v.departmentsExtra} reach_missing=${v.reachMissing} reach_extra=${v.reachExtra} (reads fall back to legacy until re-trusted)`);
   }
  }catch(error){
   out.tenantsFailed++;
   log(`access-visible-employment could not verify tenant=${id}: ${(error as Error).name}`);
  }
 }
 return out;
}

/** 0 clean · 3 a tenant differs or is untrusted · 2 a tenant could not be rebuilt or checked. */
export function accessVisibleEmploymentExitCode(run:AccessVisibleEmploymentCheck):number{
 if(run.tenantsFailed>0)return 2;
 if(run.tenantsDiffering>0||run.tenantsUntrusted>0)return 3;
 return 0;
}
