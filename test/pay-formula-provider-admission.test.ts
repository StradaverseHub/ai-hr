/** Actual DB authority; provider transport is synthetic; current production review and stale binding are checked explicitly.
 * This test issues no approval; literal source-owned human review remains authoritative. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import * as configuration from '../core/ai-config';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {draftPayFormula} from '../core/pay-formula-ai';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const fixture=vi.hoisted(()=>({reviewed:true,stale:false}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{
 const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();
 return {...actual,assertProviderDataContractReviewed:(contract:string,digest:string)=>{
  if(contract==='authored_pay_formula_v2'&&fixture.reviewed)return;
  return actual.assertProviderDataContractReviewed(contract,fixture.stale?'0'.repeat(64):digest);
 }};
});
let base:Base,ctx:SessionContext,beforeAdmission:(()=>Promise<void>)|undefined,retarget=false;
const input={requirement:'Return basic pay for this fictional calculation',disclosureAccepted:true};
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);fixture.reviewed=true;fixture.stale=false;beforeAdmission=undefined;retarget=false;
 vi.stubEnv('OPENAI_API_KEY','fictional-formula-transport');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 const generate=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return generate(cfg,retarget?{...args,prompt:args.prompt+' changed'}:args);});
 vi.spyOn(configuration,'resolveActiveAiConfig');vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({source:'Return {#Basic}',explanation:'A fictional draft',questions:[],unsupported:[]});});
});
async function counts(){const result:Record<string,number>={};for(const table of ['pay_formula','pay_formula_revision','pay_formula_test','pay_formula_event','domain_event','payroll_batch','payslip']){const [r]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from ${sql.identifier(table)}`);result[table]=r.n;}return result;}
describe('formula authoring provider admission',()=>{
 it('sends the exact disclosed requirement and code metadata without reading or writing payroll facts',async()=>{
  const before=await counts();expect(await draftPayFormula(ctx,input)).toMatchObject({valid:true,source:'Return {#Basic}'});
  expect(openaiAdapter.generate).toHaveBeenCalledOnce();const sent=JSON.parse(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt);
  expect(Object.keys(sent).sort()).toEqual(['fields','functions','requirement']);expect(sent.requirement).toBe(input.requirement);expect(await counts()).toEqual(before);
 });
 it('refuses an actual nonadministrator before configuration or transport',async()=>{
  await expect(draftPayFormula(await entitledCtx(base,['employee']),input)).rejects.toThrow();expect(configuration.resolveActiveAiConfig).not.toHaveBeenCalled();expect(openaiAdapter.generate).not.toHaveBeenCalled();
 });
 it('enforces an actually stale disclosure binding before transport',async()=>{
  fixture.reviewed=false;fixture.stale=true;await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();
 });
 it.each(['module','login'] as const)('rechecks %s authority at actual admission',async kind=>{
  beforeAdmission=async()=>{if(kind==='module')await setModule(base.tenantId,'payroll','disabled');else await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));};
  await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();
 });
 it('refuses field metadata disabled after preparation before transport',async()=>{
  beforeAdmission=async()=>{await owner.db.execute(sql`insert into pay_formula_personnel_registration(tenant_id,source_key,ordinal,label,description,enabled,created_by) values(${base.tenantId}::uuid,'companyId',1,'Company','Fictional registration policy',false,${base.adminUserId}::uuid)`);};
  await expect(draftPayFormula(ctx,input)).rejects.toThrow('The current AI source access could not be confirmed.');expect(openaiAdapter.generate).not.toHaveBeenCalled();
 });
 it('refuses changed outbound bytes even after native source preparation',async()=>{retarget=true;await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it.each(['module','login'] as const)('rechecks %s authority after the provider reply',async kind=>{
  vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});if(kind==='module')await setModule(base.tenantId,'payroll','disabled');else await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));return JSON.stringify({source:'Return 1',explanation:'A draft',questions:[],unsupported:[]});});
  const before=await counts();await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(await counts()).toEqual(before);
 });
 it('keeps the revised contract blocked until its exact source is reviewed',async()=>{
  fixture.reviewed=false;await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();
 });
 it('has no provider call when unconfigured',async()=>{
  vi.mocked(configuration.resolveActiveAiConfig).mockResolvedValueOnce(null);await expect(draftPayFormula(ctx,input)).rejects.toThrow('not_configured');expect(openaiAdapter.generate).not.toHaveBeenCalled();
 });
 it('propagates a provider timeout without formula writes',async()=>{
  vi.mocked(openaiAdapter.generate).mockRejectedValueOnce(new Error('fixture provider timeout'));const before=await counts();await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(await counts()).toEqual(before);
 });
 it('refuses a fabricated catalogue reference after the model response',async()=>{
  vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({source:'Return {#PayItem}("INVENTED")',explanation:'Invented reference',questions:[],unsupported:[]});});
  const before=await counts();await expect(draftPayFormula(ctx,input)).rejects.toThrow();expect(await counts()).toEqual(before);
 });
});
