/** ADR 0181 Phase 2 pilot: the scheduled rebuild-and-compare of precomputed company access (migration 7210,
 * docs/adr/0181-addendum-precomputed-company-access.md section 7).
 *
 * OWNER CONNECTION. For every tenant with companies it calls app.access_effective_company_verify, which recomputes
 * the company closure and the access rows from scratch and compares them with the rows maintained by the 7210
 * triggers. A closure past its date window (a future-dated restructure that took effect) is recomputed first; that
 * is expected and is not a difference. Any difference marks the tenant untrusted in the database, so its reads fall
 * back to the legacy per-company answer until an operator re-trusts it (app.access_effective_company_retrust).
 *
 * Output: counts per tenant only when that tenant differs (the operator needs the id to re-trust it), and one
 * summary line. No person, user, company or HR value. */
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';

export type AccessEffectiveCompanyVerification={windowRefreshed:boolean;closureMissing:number;closureExtra:number;rowsMissing:number;rowsExtra:number;trusted:boolean};
export type AccessEffectiveCompanyCheck={tenantsChecked:number;tenantsFailed:number;tenantsDiffering:number;tenantsUntrusted:number;windowsRefreshed:number};

export const verificationDifferences=(v:AccessEffectiveCompanyVerification)=>v.closureMissing+v.closureExtra+v.rowsMissing+v.rowsExtra;

export async function verifyAccessEffectiveCompanyTenant(owner:Db,tenantId:string):Promise<AccessEffectiveCompanyVerification>{
 const [row]=await owner.transaction(tx=>tx.execute<{window_refreshed:boolean;closure_missing:number;closure_extra:number;rows_missing:number;rows_extra:number;trusted:boolean}>(
  sql`select * from app.access_effective_company_verify(${tenantId}::uuid)`));
 return{windowRefreshed:row.window_refreshed,closureMissing:Number(row.closure_missing),closureExtra:Number(row.closure_extra),
  rowsMissing:Number(row.rows_missing),rowsExtra:Number(row.rows_extra),trusted:row.trusted};
}

export async function accessEffectiveCompanyCheck(owner:Db,log:(line:string)=>void=()=>{}):Promise<AccessEffectiveCompanyCheck>{
 const tenants=Array.from(await owner.execute<{id:string}>(sql`select distinct tenant_id::text as id from company order by 1`));
 const out:AccessEffectiveCompanyCheck={tenantsChecked:0,tenantsFailed:0,tenantsDiffering:0,tenantsUntrusted:0,windowsRefreshed:0};
 for(const {id} of tenants){
  try{
   const v=await verifyAccessEffectiveCompanyTenant(owner,id);
   out.tenantsChecked++;
   if(v.windowRefreshed)out.windowsRefreshed++;
   if(!v.trusted)out.tenantsUntrusted++;
   if(verificationDifferences(v)>0){
    out.tenantsDiffering++;
    log(`access-effective-company DIFFERENCE tenant=${id} closure_missing=${v.closureMissing} closure_extra=${v.closureExtra} rows_missing=${v.rowsMissing} rows_extra=${v.rowsExtra} (reads fall back to legacy until re-trusted)`);
   }
  }catch(error){
   out.tenantsFailed++;
   log(`access-effective-company could not verify tenant=${id}: ${(error as Error).name}`);
  }
 }
 return out;
}

/** 0 checked and clean · 3 a tenant differs or is untrusted · 2 a tenant could not be checked. */
export function accessEffectiveCompanyExitCode(run:AccessEffectiveCompanyCheck):number{
 if(run.tenantsFailed>0)return 2;
 if(run.tenantsDiffering>0||run.tenantsUntrusted>0)return 3;
 return 0;
}
