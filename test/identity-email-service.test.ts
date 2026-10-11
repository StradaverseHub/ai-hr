import { describe,expect,it,vi } from 'vitest';
import { createEmailService, type EmailState, type EmailDependencies } from '../deploy/identity-email/service';
import { emailConfigSchema, type IdentityEmailActor, type EmailConfig } from '../lib/identity/email-model';
const actor:IdentityEmailActor={issuer:'https://hr.test/identity/realms/ai-hr',subject:'owner',userId:'22222222-2222-4222-8222-222222222222',tenantId:'11111111-1111-4111-8111-111111111111'};
const config:EmailConfig={host:'smtp.example.test',port:465,security:'tls',from:'login@example.test',fromName:'HR',replyTo:'',auth:true,user:'smtp-user'};
function fixture(){
 let state:EmailState={drafts:{},active:null};let realm:{smtpServer?:Record<string,string>;resetPasswordAllowed?:boolean}={resetPasswordAllowed:false};
 let time=Date.now();const vault=new Map<string,string>();
 const d:EmailDependencies={revisionKey:'test-key',testRecipient:'owner@example.test',now:()=>new Date(time),
  authorize:vi.fn(async()=> 'owner@example.test'),audit:vi.fn(async()=>{}),
  realm:vi.fn(async(method,body)=>{if(method==='PUT')realm={...realm,...body as object};return structuredClone(realm);}),
  test:vi.fn(async()=>{}),load:async()=>structuredClone(state),store:async value=>{state=structuredClone(value);},vault:async(key,password)=>{vault.set(key,password);}};
 const run=createEmailService(d);
 const view=()=>run({op:'view',actor}) as Promise<{revision:string;draft:{id:string;testedAt:string|null;hasPassword:boolean}|null;active:unknown}>;
 async function save(password='super-secret'){return run({op:'save',actor,revision:(await view()).revision,config,password}) as ReturnType<typeof view>;}
 return {d,run,view,save,vault,advance:()=>{time+=31*60_000;},change:()=>{realm.smtpServer={host:'external.example.test'};},realm:()=>realm};
}
describe('installation email settings lifecycle',()=>{
 it('requires exact enrolled identity before reading configuration or sending any mail',async()=>{
  const f=fixture();vi.mocked(f.d.authorize).mockResolvedValue(null);
  await expect(f.view()).rejects.toMatchObject({code:'forbidden'});expect(f.d.realm).not.toHaveBeenCalled();expect(f.d.test).not.toHaveBeenCalled();
 });
 it('does not accept arbitrary test recipients or realm updates',async()=>{
  const f=fixture();await expect(f.run({op:'test',actor,draftId:crypto.randomUUID(),recipient:'victim@example.test'})).rejects.toMatchObject({code:'invalid'});
  await expect(f.run({op:'save',actor,revision:'0'.repeat(64),config:{...config,registrationAllowed:true}})).rejects.toMatchObject({code:'invalid'});
 });
 it('keeps credentials in the vault and leaves active mail untouched by a save or test',async()=>{
  const f=fixture();const saved=await f.save();expect(JSON.stringify(saved)).not.toContain('super-secret');expect(saved.draft?.hasPassword).toBe(true);expect(f.vault.size).toBe(1);
  await f.run({op:'test',actor,draftId:saved.draft!.id});expect(f.realm().smtpServer).toBeUndefined();expect(f.realm().resetPasswordAllowed).toBe(false);
  const smtp=vi.mocked(f.d.test).mock.calls[0][0];expect(smtp.ssl).toBe('true');expect(smtp.starttls).toBe('false');expect(smtp.password).toMatch(/^\$\{vault.smtp-/);expect(smtp.password).not.toContain('super-secret');
 });
 it('requires a current successful send and explicit inbox receipt before activation',async()=>{
  const f=fixture(),saved=await f.save(),draftId=saved.draft!.id;
  await expect(f.run({op:'apply',actor,draftId,received:true})).rejects.toMatchObject({code:'needsTest'});
  await f.run({op:'test',actor,draftId});await expect(f.run({op:'apply',actor,draftId,received:false})).rejects.toMatchObject({code:'needsReceipt'});
  await f.run({op:'apply',actor,draftId,received:true});expect(f.realm().smtpServer?.host).toBe(config.host);expect(f.realm().resetPasswordAllowed).toBe(true);
  expect(await f.run({op:'readiness'})).toEqual({ready:true});expect((await f.view()).draft).toBeNull();
  const actions=vi.mocked(f.d.audit).mock.calls.map(c=>c[1]);expect(actions).toEqual(['draft-saved','test-requested','test-accepted','apply-requested','applied']);
 });
 it('invalidates testing after a save, expires tests, and refuses replaced or stale drafts',async()=>{
  const f=fixture();const first=await f.save();await f.run({op:'test',actor,draftId:first.draft!.id});const second=await f.save('');expect(second.draft?.testedAt).toBeNull();
  await expect(f.run({op:'apply',actor,draftId:first.draft!.id,received:true})).rejects.toMatchObject({code:'conflict'});
  await f.run({op:'test',actor,draftId:second.draft!.id});f.advance();await expect(f.run({op:'apply',actor,draftId:second.draft!.id,received:true})).rejects.toMatchObject({code:'needsTest'});
  f.change();await expect(f.run({op:'test',actor,draftId:second.draft!.id})).rejects.toMatchObject({code:'conflict'});
 });
 it('keeps a working relay after a failed replacement test, without echoing provider errors',async()=>{
  const f=fixture(),saved=await f.save();await f.run({op:'test',actor,draftId:saved.draft!.id});await f.run({op:'apply',actor,draftId:saved.draft!.id,received:true});
  const replacement=await f.save('new-secret');vi.mocked(f.d.test).mockRejectedValue(new Error('AUTH new-secret'));
  await expect(f.run({op:'test',actor,draftId:replacement.draft!.id})).rejects.toMatchObject({code:'rejected',message:'Identity email settings: rejected'});
  expect(await f.run({op:'readiness'})).toEqual({ready:true});expect((await f.view()).draft?.testedAt).toBeNull();
 });
 it('does not mutate a realm when the intent audit fails',async()=>{
  const f=fixture(),saved=await f.save();await f.run({op:'test',actor,draftId:saved.draft!.id});vi.mocked(f.d.audit).mockRejectedValue(new Error('audit unavailable'));
  await expect(f.run({op:'apply',actor,draftId:saved.draft!.id,received:true})).rejects.toThrow();expect(f.realm().smtpServer).toBeUndefined();
 });
 it('reports uncertain writes and keeps their vault secret for reconciliation',async()=>{
  const f=fixture(),saved=await f.save();await f.run({op:'test',actor,draftId:saved.draft!.id});vi.mocked(f.d.realm).mockImplementation(async(method)=>{if(method==='PUT')throw new Error('timeout');return {};});
  // Establish matching revision for the new observation, then test again.
  const next=await f.save('');await f.run({op:'test',actor,draftId:next.draft!.id});
  await expect(f.run({op:'apply',actor,draftId:next.draft!.id,received:true})).rejects.toMatchObject({code:'uncertain'});expect(f.vault.size).toBe(1);
 });
 it('serializes saves and refuses an older draft after concurrent saves',async()=>{
  const f=fixture();const revision=(await f.view()).revision;
  const saved=await Promise.all([1,2].map(()=>f.run({op:'save',actor,revision,config,password:'secret'}))) as Array<{draft:{id:string}}>;
  expect(saved[0].draft.id).not.toBe(saved[1].draft.id);await expect(f.run({op:'test',actor,draftId:saved[0].draft.id})).rejects.toMatchObject({code:'conflict'});
 });
 it('never borrows another operator’s draft or saved password',async()=>{
  const f=fixture();const saved=await f.save();const other={...actor,subject:'other'};
  await expect(f.run({op:'test',actor:other,draftId:saved.draft!.id})).rejects.toMatchObject({code:'conflict'});
  await expect(f.run({op:'save',actor:other,revision:(await f.view()).revision,config,password:''})).rejects.toMatchObject({code:'invalid'});
 });
 it('rejects unsafe transports, header injection and URL hosts',()=>{
  for(const bad of [{security:'starttls'},{security:'none'},{host:'https://smtp.test'},{fromName:'HR\r\nBcc: victim@test'},{user:''}])expect(emailConfigSchema.safeParse({...config,...bad}).success).toBe(false);
 });
});
