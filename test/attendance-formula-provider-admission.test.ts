/** Real native authority and synthetic transport. This fixture grants no production disclosure approval. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import * as configuration from '../core/ai-config';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {draftAttendanceFormula} from '../packs/attendance/service';
import {setAiCentreReadControl} from '../core/ai-centre-inventory';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const fixture=vi.hoisted(()=>({technicalAdmission:true}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();return {...actual,assertProviderDataContractReviewed:(contract:string,digest:string)=>{if(contract==='authored_attendance_formula_v1'&&fixture.technicalAdmission)return;return actual.assertProviderDataContractReviewed(contract,digest);}};});
let base:Base,ctx:SessionContext,beforeAdmission:(()=>Promise<void>)|undefined,retarget=false;
const response=()=>JSON.stringify({source:'Return {#FormulaID}("TotalWorkingMins") / 60',conditions:[],explanation:'Fictional bounded proposal',questions:[],assumptions:[]});
const input=()=>({companyId:base.companyId,requirement:'Fictional worked hours rule',disclosureAccepted:true});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();base=await seedBase();ctx=await entitledCtx(base);fixture.technicalAdmission=true;beforeAdmission=undefined;retarget=false;
 vi.stubEnv('OPENAI_API_KEY','fictional-attendance-transport');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 const generate=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return generate(cfg,retarget?{...args,prompt:args.prompt+' changed'}:args);});
 vi.spyOn(configuration,'resolveActiveAiConfig');vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return response();});
});
async function counts(){const result:Record<string,number>={};for(const table of ['attendance_formula','attendance_formula_revision','attendance_formula_test','attendance_formula_event','domain_event','attendance','payroll_batch','payslip']){const [r]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from ${sql.identifier(table)}`);result[table]=r.n;}return result;}
describe('Attendance proposal native provider admission',()=>{
 it('sends only explicit wording and public grammar without saving a formula, altering attendance or posting pay',async()=>{
  const before=await counts();expect(await draftAttendanceFormula(ctx,input())).toMatchObject({valid:true});expect(openaiAdapter.generate).toHaveBeenCalledOnce();const sent=JSON.parse(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt);expect(Object.keys(sent).sort()).toEqual(['fields','requirement','variables']);expect(sent.requirement).toBe(input().requirement);expect(JSON.stringify(sent)).not.toContain(base.companyId);expect(await counts()).toEqual(before);
 });
 it('refuses actual nonadministrators before configuration or transport',async()=>{await expect(draftAttendanceFormula(await entitledCtx(base,['employee']),input())).rejects.toThrow();expect(configuration.resolveActiveAiConfig).not.toHaveBeenCalled();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('refuses a foreign company and forged public native-source properties',async()=>{const other=await seedBase();await expect(draftAttendanceFormula(ctx,{...input(),companyId:other.companyId})).rejects.toThrow();await expect(draftAttendanceFormula(ctx,{...input(),employee:{salary:'private'}})).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('enforces the real missing approval for this new purpose before transport',async()=>{fixture.technicalAdmission=false;await expect(draftAttendanceFormula(ctx,input())).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it.each(['module','login'] as const)('rechecks %s authority at admission',async kind=>{beforeAdmission=async()=>{if(kind==='module')await setModule(base.tenantId,'attendance','disabled');else await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));};await expect(draftAttendanceFormula(ctx,input())).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('refuses changed provider bytes after preparation',async()=>{retarget=true;await expect(draftAttendanceFormula(ctx,input())).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('observes its child control and the global stop without affecting a sibling',async()=>{await setAiCentreReadControl(ctx,'read:operation_attendance_formula_draft',false);await expect(draftAttendanceFormula(ctx,input())).rejects.toMatchObject({reason:'paused'});await setAiCentreReadControl(ctx,'read:operation_attendance_formula_draft',true);await setMandateStopSwitch(ctx,true);await expect(draftAttendanceFormula(ctx,input())).rejects.toMatchObject({reason:'paused'});expect(configuration.resolveActiveAiConfig).not.toHaveBeenCalled();expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('rechecks native access after the reply and retains no formula or pay effect',async()=>{vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));return response();});const before=await counts();await expect(draftAttendanceFormula(ctx,input())).rejects.toThrow();expect(await counts()).toEqual(before);});
 it('refuses model-created authority and propagates timeout without business writes',async()=>{vi.mocked(openaiAdapter.generate).mockResolvedValueOnce(JSON.stringify({source:'Return 1',conditions:[],explanation:'Fictional',questions:[],assumptions:[],activate:true}));const before=await counts();await expect(draftAttendanceFormula(ctx,input())).rejects.toThrow();vi.mocked(openaiAdapter.generate).mockRejectedValueOnce(Error('fictional timeout'));await expect(draftAttendanceFormula(ctx,input())).rejects.toThrow();expect(await counts()).toEqual(before);});
});
