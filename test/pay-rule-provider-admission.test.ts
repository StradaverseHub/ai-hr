/** Authored UNRUN: real role/module/config/admission, only provider transport mocked.
 * Drafting classifies fictional human input; it reads no employee payroll values and commits no pay rule. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import * as configuration from '../core/ai-config';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {draftPayRule,PayRuleDraftError} from '../core/pay-rule-ai';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,a:SessionContext,beforeAdmission:(()=>Promise<void>)|undefined,retarget=false;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');a={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 vi.stubEnv('OPENAI_API_KEY','fictional-pay-rule-transport-only');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');beforeAdmission=undefined;retarget=false;
 const generate=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return generate(cfg,retarget?{...args,prompt:args.prompt+' ALTERED'}:args);});
 vi.spyOn(configuration,'resolveActiveAiConfig');vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({kind:'percent_of'});});
});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
describe('pay-rule administrative provider boundary',()=>{
 it('admits the actual native administrator while withholding BOTH bounded human fields without changing canonical payroll rows',async()=>{
  const before=await owner.db.select().from(schema.payComponent);expect(await draftPayRule(a,{description:'10% of basic',componentCode:'private@fixture.test'})).toMatchObject({rule:{kind:'percent_of',base:'basic',pct:10}});
  expect(openaiAdapter.generate).toHaveBeenCalledOnce();const prompt=vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt;expect(prompt).not.toMatch(/jane@fixture|private@fixture|910101-01-1234/);expect(JSON.parse(prompt)).toEqual({requestedKind:'percent_of',componentProrates:false});expect(prompt).not.toContain('10');expect(await owner.db.select().from(schema.payComponent)).toEqual(before);expect(await runs()).toMatchObject([{state:'completed',actualTokens:0}]);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'pay-component.ai-rule-drafted'));expect(JSON.stringify(events)).not.toMatch(/private@fixture|jane@fixture|910101-01-1234/);
 });
 it('refuses an actual nonadmin before even looking up the provider',async()=>{
  const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional ordinary caller',primaryEmail:randomUUID()+'@fixture.test'}).returning(),userId=await createAppUser(b.tenantId,person.id,'employee'),self:SessionContext={...await entitledCtx(b,['employee']),userId,personId:person.id,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await expect(draftPayRule(self,{description:'10% of basic'})).rejects.toThrow();expect(configuration.resolveActiveAiConfig).not.toHaveBeenCalled();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
 });
 it.each(['module','login'] as const)('refuses actual %s revocation between provider preparation and admission with no call or charge',async kind=>{
  beforeAdmission=async()=>{if(kind==='module')await setModule(b.tenantId,'payroll','disabled');else await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,b.adminUserId));};
  await expect(draftPayRule(a,{description:'10% of basic'})).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
 });
 it('cannot reuse administrative admission for changed outbound bytes',async()=>{retarget=true;await expect(draftPayRule(a,{description:'10% of basic'})).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('captures human fields and proration context before the first await',async()=>{
  const input={description:'per day: 50',componentCode:'ORIGINAL',componentProrates:false};beforeAdmission=async()=>{input.description='Changed retained input';input.componentCode='changed@fixture.test';input.componentProrates=true;};vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({kind:'per_day'});});
  expect(await draftPayRule(a,input)).toMatchObject({rule:{kind:'per_day',rate:50}});const prompt=vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt;expect(JSON.parse(prompt)).toEqual({requestedKind:'per_day',componentProrates:false});expect(prompt).not.toContain('ORIGINAL');expect(prompt).not.toContain('50');expect(prompt).not.toMatch(/Changed retained|changed@fixture/);
 });
 it.each([{description:'x'.repeat(4001)},{description:'Valid description',componentCode:'x'.repeat(101)}])('refuses oversized human inputs before configuration lookup',async input=>{await expect(draftPayRule(a,input)).rejects.toThrow();expect(configuration.resolveActiveAiConfig).not.toHaveBeenCalled();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('never exposes the mocked raw provider body through a core gateway failure',async()=>{vi.mocked(openaiAdapter.generate).mockRejectedValueOnce(new Error('PRIVATE provider body key=fictional-secret'));let error:unknown;try{await draftPayRule(a,{description:'10% of basic'});}catch(e){error=e;}expect(error).toBeInstanceOf(PayRuleDraftError);expect(String(error)).not.toMatch(/PRIVATE|fictional-secret|provider body/);});
});
