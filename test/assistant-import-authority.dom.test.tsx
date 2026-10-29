import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({principal:vi.fn(),assistant:vi.fn(),module:vi.fn(),resolve:vi.fn(),generate:vi.fn(),admission:null as null|(()=>Promise<void>)}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,run:(tx:object)=>unknown)=>run({})}));
vi.mock('../core/ai-principal',()=>({assertAiPrincipalTx:m.principal}));
vi.mock('../core/assistant-grant',()=>({assertMayUseAssistant:m.assistant}));
vi.mock('../core/entitlements',()=>({assertModuleEnabled:m.module,resolveEntitlementsTx:async()=>undefined}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:m.resolve}));
vi.mock('../core/ai-governance',()=>({withAiAdmissionCheck:(cfg:unknown,_feature:unknown,check:(tx:object)=>Promise<void>)=>{m.admission=()=>check({});return cfg;}}));
vi.mock('../lib/ai',()=>({generateDraft:m.generate}));
import {prepareAssistantImport} from '../core/assistant-import';
const ctx={tenantId:'tenant',userId:'admin',roles:['hr_admin']};
const input={target:'employee',source:'Alice',instruction:'Prepare employees',consent:true};
beforeEach(()=>{vi.resetAllMocks();m.admission=null;m.resolve.mockResolvedValue({provider:'test'});m.generate.mockImplementation(async()=>{await m.admission?.();return JSON.stringify({rows:[{cells:[{field:'full_name',start:0,end:5}]}]});});});
describe('assistant import authority and dispatch',()=>{
 it('checks the fresh principal, assistant grant and module before resolution and again at admission',async()=>{
  const result=await prepareAssistantImport(ctx,input);expect(result.rows[0]).toContain('Alice');
  expect(m.principal).toHaveBeenCalledTimes(2);expect(m.assistant).toHaveBeenCalledTimes(2);expect(m.module).toHaveBeenCalledWith(ctx,'employees');
  expect(m.resolve).toHaveBeenCalledWith({},ctx,'hr_assistant');expect(m.generate).toHaveBeenCalledTimes(1);
 });
 it.each(['principal','assistant','module'] as const)('refuses %s failures before any provider dispatch',async gate=>{
  m[gate].mockImplementation(()=>{throw Error('denied');});await expect(prepareAssistantImport(ctx,input)).rejects.toThrow();expect(m.generate).not.toHaveBeenCalled();expect(m.resolve).not.toHaveBeenCalled();
 });
 it('refuses employee and synthetic contexts before configuration is resolved',async()=>{
  await expect(prepareAssistantImport({...ctx,roles:['employee']},input)).rejects.toThrow();expect(m.resolve).not.toHaveBeenCalled();
 });
 it('refuses missing consent and unsolicited request fields',async()=>{
  await expect(prepareAssistantImport(ctx,{...input,consent:false})).rejects.toThrow();
  await expect(prepareAssistantImport(ctx,{...input,commit:true})).rejects.toThrow();expect(m.principal).not.toHaveBeenCalled();
 });
 it('never retries an unavailable provider or invalid model output',async()=>{
  m.resolve.mockResolvedValueOnce(null);await expect(prepareAssistantImport(ctx,input)).rejects.toThrow();expect(m.generate).not.toHaveBeenCalled();
  m.generate.mockResolvedValueOnce('{"rows":[{"cells":[{"field":"full_name","start":0,"end":99}]}]}');await expect(prepareAssistantImport(ctx,input)).rejects.toThrow();expect(m.generate).toHaveBeenCalledTimes(1);
 });
 it('rechecks revocation at admission',async()=>{
  m.principal.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('revoked'));
  await expect(prepareAssistantImport(ctx,input)).rejects.toThrow('revoked');expect(m.principal).toHaveBeenCalledTimes(2);
 });
});
