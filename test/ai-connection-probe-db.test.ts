import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {testConnection} from '../core/ai-config';
import {withTenant} from '../db/client';
import {aiModelRun} from '../db/schema';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(closeAll);
const rows=()=>owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,base.tenantId));
describe('connection probe ledger (R9)',()=>{
 it.each([true,false])('commits pending receipt before transport and settles ok=%s with no credential or workload content',async ok=>{
  const validate=vi.spyOn(openaiAdapter,'validate').mockImplementation(async()=>{
   const pending=await rows();expect(pending).toHaveLength(1);expect(pending[0]).toMatchObject({operation:'probe',state:'pending',reservedTokens:0,userId:base.adminUserId});return {ok};
  });
  try{expect(await testConnection(adminCtx(base),{provider:'openai',model:'gpt-5.5',apiKey:'fictional-probe-key'})).toEqual({ok});}finally{validate.mockRestore();}
  const stored=await rows();expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({featureId:'provider_evaluation',operation:'probe',state:ok?'completed':'failed',actualTokens:null});
  expect(JSON.stringify(stored)).not.toContain('fictional-probe-key');
  const usage=await withTenant(adminCtx(base),tx=>tx.execute(sql`select * from app.ai_feature_usage()`));expect(usage).toHaveLength(0);
 });
 it('refuses a no-login actor and direct app-role receipt forgery',async()=>{
  const ctx={...adminCtx(base),userId:undefined},validate=vi.spyOn(openaiAdapter,'validate');
  try{await expect(testConnection(ctx,{provider:'openai',model:'gpt-5.5',apiKey:'fictional'})).rejects.toThrow();expect(validate).not.toHaveBeenCalled();}finally{validate.mockRestore();}
  await expect(withTenant(adminCtx(base),tx=>tx.execute(sql`insert into ai_model_run(tenant_id,feature_id,operation,provider,model,state,reserved_tokens) values(${base.tenantId}::uuid,'provider_evaluation','probe','openai','fixture','completed',0)`))).rejects.toThrow();
  expect(await rows()).toHaveLength(0);
 });
 it('does not count probes against a daily user workload allowance',async()=>{
  const ctx=adminCtx(base);
  await withTenant(ctx,async tx=>{
   await tx.execute(sql`select app.ai_probe_start('openai','fixture')`);
   await tx.execute(sql`insert into ai_control_policy(tenant_id,scope_key,kind,subject_id,enabled,daily_requests) values(${base.tenantId}::uuid,${'user:'+base.adminUserId},'user',${base.adminUserId}::uuid,true,1)`);
   const admitted=await tx.execute<{allowed:boolean}>(sql`select * from app.ai_admit('pay_rule_draft','draft','openai','fixture',10,false)`);expect(admitted[0].allowed).toBe(true);
  });
 });
});
