/** Exclusive diagnostic-owned transactions only; no borrowed-Tx setting wrapper. */
import {sql} from 'drizzle-orm';
import {expect,vi} from 'vitest';
import * as database from '../../db/client';
import type {SessionContext,Tx} from '../../db/client';
export async function preserveDiagnosticFailure<T>(work:()=>Promise<T>,cleanup:()=>Promise<void>):Promise<T>{
 const result=await Promise.resolve().then(work).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
 try{await cleanup();}catch(error){if(!result.ok)throw new AggregateError([result.error,error],'Native purpose diagnostic and cleanup both failed',{cause:result.error});throw error;}
 if(!result.ok)throw result.error;return result.value;
}
export async function employeeChoicePurposeSession(phase:'timing'|'plans',assertActive:()=>void,record:(value:unknown)=>void,poisoned:(error:Error)=>void){
 assertActive();
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','employee_choice_native_purpose_'+phase);
 const single=database.createDb(url.toString(),{max:1});expect(single.client.options.max).toBe(1);
 let active=false,poison:Error|undefined,closed=false;
 const check=()=>{assertActive();if(poison)throw poison;if(closed)throw Error('Native purpose diagnostic session already closed');};
 const settings=async()=>{
  const [row]=await single.client`select pg_backend_pid() as pid,current_user as role,session_user as login,current_database() as database,
   current_setting('jit') as jit,current_setting('jit_above_cost') as jit_above_cost,current_setting('jit_inline_above_cost') as jit_inline_above_cost,
   current_setting('jit_optimize_above_cost') as jit_optimize_above_cost,current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
   current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout,current_setting('plan_cache_mode') as plan_cache_mode,
   nullif(current_setting('app.tenant_id',true),'') is null and nullif(current_setting('app.user_id',true),'') is null
    and nullif(current_setting('app.roles',true),'') is null and nullif(current_setting('app.grants',true),'') is null
    and nullif(current_setting('app.agent_principal_id',true),'') is null as context_cleared`;
  return row;
 };
 let defaults:Awaited<ReturnType<typeof settings>>;
 try{defaults=await settings();expect(defaults).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',jit:'on',context_cleared:true});}
 catch(error){await single.client.end({timeout:0});throw error;}
 const verify=async(label:string)=>{
  check();try{const after=await settings();expect(after).toEqual(defaults);record({kind:'NATIVE_SESSION_RESTORED',phase,label,...after});}
  catch(error){poison=new Error('Native purpose session restoration uncertain; all later work refused',{cause:error});poisoned(poison);throw error;}
 };
 const install=()=>vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  check();expect(options?.readOnlySnapshot).toBe(true);if(active)return Promise.reject(new Error('Native purpose session already has a transaction'));
  active=true;
  return preserveDiagnosticFailure(()=>single.withTenant(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   const [mode]=await tx.execute<{pid:number;role:string;login:string;tenant:string;user:string;jit:string;isolation:string;read_only:string;all_rls:boolean;advisory:boolean}>(sql`select pg_backend_pid() as pid,current_user as role,session_user as login,
    app.current_tenant_id() as tenant,app.current_user_id() as "user",current_setting('jit') as jit,current_setting('transaction_isolation') as isolation,
    current_setting('transaction_read_only') as read_only,row_security_active('public.employment'::regclass) and row_security_active('public.person'::regclass)
     and row_security_active('public.assignment'::regclass) and row_security_active('public.company'::regclass)
     and row_security_active('public.department'::regclass) and row_security_active('public.business_unit'::regclass) as all_rls,
    exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) as advisory`);
   expect(mode).toEqual({pid:defaults.pid,role:'ai_hr_app',login:'ai_hr_app',tenant:ctx.tenantId,user:ctx.userId,jit:defaults.jit,isolation:'repeatable read',read_only:'on',all_rls:true,advisory:false});
   record({kind:'NATIVE_PRESENTATION_TRANSACTION',phase,...mode});return read(tx);
  },options),()=>verify('COMMIT_OR_ROLLBACK')).finally(()=>{active=false;});
 });
 return {single,defaults,install,verify,
  assertIdle(){check();if(active)throw Error('Native purpose transaction still active');},
  async close(){if(closed)return;closed=true;await single.client.end({timeout:0});},
 };
}
