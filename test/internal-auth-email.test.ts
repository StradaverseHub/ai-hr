import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { credentialByLogin } from '../lib/internal-auth/service';
import { internalEmailRequest, recoveryMailReady } from '../lib/internal-auth/mail';
import { readLifecycleRelayTx, readActiveRelayTx } from '../lib/internal-auth/active-relay';
import { client } from '../db/client';
import type { EmailConfig, EmailSettingsView, IdentityEmailActor } from '../lib/identity/email-model';
const session = vi.hoisted(() => ({ context: null as SessionContext | null, identity: null as {issuer:string;subject:string;email:string;emailVerified:boolean} | null }));
vi.mock('../lib/session', () => ({ getSession: async () => session.context }));
vi.mock('../lib/internal-auth/web-session', () => ({ currentInternalIdentity: async () => session.identity }));
let base: Base, actor: IdentityEmailActor;
const config: EmailConfig = { host:'smtp.private.test',port:465,security:'tls',from:'hr@example.test',fromName:'AI HR',replyTo:'',auth:true,user:'relay-user' };
const secret = 'synthetic-relay-secret-991';
beforeAll(migrateTestDb); beforeEach(async () => {
  await resetDb(); base = await seedBase();
  vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));
  await bootstrapInternalOwner(owner.client,{appUserId:base.adminUserId,organization:'alpha',username:'owner',email:'owner@example.test',password:'A synthetic private passphrase 771!',installationOperator:true});
  const c=(await credentialByLogin('alpha','owner'))!;
  actor={userId:base.adminUserId,tenantId:base.tenantId,issuer:c.issuer,subject:c.subject};session.context=adminCtx(base);session.identity={issuer:c.issuer,subject:c.subject,email:c.email,emailVerified:true};
}); afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
const view=()=>internalEmailRequest<EmailSettingsView>({op:'view',actor});
async function draft() {const initial=await view();await internalEmailRequest({op:'save',actor,revision:initial.revision,config,password:secret});return (await view()).draft!;}
describe('HR-owned SMTP settings with actual private storage and authority',()=>{
  it('stores named connections privately and switches only the selected tested version after receipt',async()=>{
    const original=await view();
    const saved=await internalEmailRequest<{connectionId:string}>({op:'save',actor,revision:original.revision,connectionName:'Primary',config,password:secret});
    let selected=await internalEmailRequest<EmailSettingsView>({op:'view',actor,connectionId:saved.connectionId});
    expect(selected.connections).toHaveLength(1);expect(selected.selectedConnectionName).toBe('Primary');expect(selected.active).toBeNull();
    await expect(internalEmailRequest({op:'apply',actor,connectionId:saved.connectionId,draftId:selected.draft!.id,received:true})).rejects.toMatchObject({code:'needsTest'});
    const send=vi.fn(async()=>{});await internalEmailRequest({op:'test',actor,connectionId:saved.connectionId,draftId:selected.draft!.id},send);
    await internalEmailRequest({op:'apply',actor,connectionId:saved.connectionId,draftId:selected.draft!.id,received:true});
    selected=await internalEmailRequest<EmailSettingsView>({op:'view',actor,connectionId:saved.connectionId});
    expect(selected.connections?.filter(c=>c.active)).toHaveLength(1);
    const activeBefore=await owner.client.begin(tx=>readActiveRelayTx(tx));expect(activeBefore?.revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await internalEmailRequest({op:'save',actor,revision:selected.revision,connectionName:'Backup',config,password:'fictional-backup-secret'});
    const after=await view();expect(after.connections).toHaveLength(2);expect(after.active).toMatchObject(config);
    const activeAfter=await owner.client.begin(tx=>readActiveRelayTx(tx));expect(activeAfter?.revision).toBe(activeBefore?.revision);expect(activeAfter?.relay.config).toEqual(config);
    expect(JSON.stringify(after)).not.toContain(secret);expect(JSON.stringify(await owner.client`select * from app_internal_auth_record`)).not.toContain('fictional-backup-secret');
  });
  it('keeps an application secret encrypted and activates only the tested draft after explicit receipt',async()=>{
    const oauth:EmailConfig={...config,host:'smtp.office365.com',port:587,security:'starttls',user:'hr@example.test',authentication:'microsoft365',oauth2:{tenantId:randomUUID(),clientId:randomUUID()}};
    await internalEmailRequest({op:'save',actor,revision:(await view()).revision,config:oauth,password:secret});let current=await view();const id=current.draft!.id;
    expect(current.draft).toMatchObject({hasPassword:true,config:oauth,testedAt:null});expect(current.active).toBeNull();
    await expect(internalEmailRequest({op:'apply',actor,draftId:id,received:true})).rejects.toMatchObject({code:'needsTest'});
    const send=vi.fn(async()=>{});await internalEmailRequest({op:'test',actor,draftId:id},send);
    expect(send).toHaveBeenCalledWith({config:oauth,password:secret},expect.objectContaining({to:'owner@example.test'}));
    await expect(internalEmailRequest({op:'apply',actor,draftId:id,received:false})).rejects.toMatchObject({code:'needsReceipt'});
    await internalEmailRequest({op:'apply',actor,draftId:id,received:true});current=await view();expect(current.active).toMatchObject({...oauth,hasPassword:true});
    expect(JSON.stringify(current)).not.toContain(secret);expect(JSON.stringify(await owner.client`select * from app_internal_auth_record`)).not.toContain(secret);expect(JSON.stringify(await owner.client`select * from domain_event`)).not.toContain(secret);
    for(const patch of [{user:'other@example.test'},{oauth2:{...oauth.oauth2!,clientId:randomUUID()}},{oauth2:{...oauth.oauth2!,tenantId:randomUUID()}},{authentication:undefined,oauth2:undefined}])await expect(internalEmailRequest({op:'save',actor,revision:current.revision,config:{...oauth,...patch},password:''})).rejects.toMatchObject({code:'invalid'});
    await internalEmailRequest({op:'save',actor,revision:current.revision,config:oauth,password:''});expect((await view()).draft).toMatchObject({hasPassword:true,testedAt:null});
  });
  it('never carries a basic password into application authentication',async()=>{
    await draft();const oauth:EmailConfig={...config,host:'smtp.office365.com',port:587,security:'starttls',user:'hr@example.test',authentication:'microsoft365',oauth2:{tenantId:randomUUID(),clientId:randomUUID()}};
    await expect(internalEmailRequest({op:'save',actor,revision:(await view()).revision,config:oauth,password:''})).rejects.toMatchObject({code:'invalid'});
  });
  it('stores relay secrets only as authenticated ciphertext and never returns them to the settings view',async()=>{
    const saved=await draft();expect(saved.hasPassword).toBe(true);expect(saved.config).toEqual(config);expect(saved.testedAt).toBeNull();expect(await recoveryMailReady()).toBe(false);
    expect(await readActiveRelayTx(client)).toBeNull();
    expect(JSON.stringify(await view())).not.toContain(secret);
    expect(JSON.stringify(await owner.client`select * from app_internal_auth_record`)).not.toContain(secret);
    expect(JSON.stringify(await owner.client`select * from domain_event`)).not.toContain(secret);
  });
  it('requires successful testing and explicit receipt, then preserves a fresh revision and redacted active settings',async()=>{
    const saved=await draft(),send=vi.fn(async()=>{});
    await expect(internalEmailRequest({op:'apply',actor,draftId:saved.id,received:true})).rejects.toMatchObject({code:'needsTest'});
    await internalEmailRequest({op:'test',actor,draftId:saved.id},send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({password:secret}),expect.objectContaining({to:'owner@example.test'}));
    await expect(internalEmailRequest({op:'apply',actor,draftId:saved.id,received:false})).rejects.toMatchObject({code:'needsReceipt'});
    await internalEmailRequest({op:'apply',actor,draftId:saved.id,received:true});
    const active=await view();expect(active.active).toMatchObject({...config,hasPassword:true});expect(active.draft).toBeNull();expect(await recoveryMailReady()).toBe(true);
    expect(await client.begin(raw=>readActiveRelayTx(raw as unknown as import('../lib/internal-auth/record-store').AuthSql,true))).toEqual({revision:active.revision,relay:{config,password:secret}});
    expect(JSON.stringify(active)).not.toContain(secret);
    await expect(internalEmailRequest({op:'save',actor,revision:'initial',config,password:secret})).rejects.toMatchObject({code:'conflict'});
  });
  it('a failed retest clears prior test authority and records a sanitized audit without activating the relay',async()=>{
    const saved=await draft();await internalEmailRequest({op:'test',actor,draftId:saved.id},async()=>{});
    await expect(internalEmailRequest({op:'test',actor,draftId:saved.id},async()=>{throw new Error('private SMTP response '+secret);})).rejects.toMatchObject({code:'connectionFailed'});
    expect((await view()).draft?.testedAt).toBeNull();expect(await recoveryMailReady()).toBe(false);
    await expect(internalEmailRequest({op:'apply',actor,draftId:saved.id,received:true})).rejects.toMatchObject({code:'needsTest'});
    const events=await owner.client`select event_type,payload from domain_event where event_type='identity-email.test-failed' order by sequence`;
    expect(events).toHaveLength(1);expect(JSON.stringify(events)).not.toContain(secret);
  });
  it('refuses another identity on the same HR account and never carries a saved password to a different SMTP host',async()=>{
    await draft();const current=await view();
    await expect(internalEmailRequest({op:'save',actor,revision:current.revision,config:{...config,host:'other.private.test'},password:''})).rejects.toMatchObject({code:'invalid'});
    const subject=randomUUID();await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values('https://other.test/issuer',${subject},${base.adminUserId}::uuid)`;
    session.identity={issuer:'https://other.test/issuer',subject,email:'owner@example.test',emailVerified:true};
    await expect(internalEmailRequest({op:'view',actor:{...actor,issuer:'https://other.test/issuer',subject}})).rejects.toMatchObject({code:'forbidden'});
  });
});

it('stores confirmed lifecycle mailbox versions privately and isolates tenant/profile bindings',async()=>{
 const baseDraft=await draft();await internalEmailRequest({op:'test',actor,draftId:baseDraft.id},async()=>{});await internalEmailRequest({op:'apply',actor,draftId:baseDraft.id,received:true});
 const original=await readActiveRelayTx(client),initial=await internalEmailRequest<EmailSettingsView>({op:'view',actor,connectionId:'new'});
 const saved=await internalEmailRequest<{connectionId:string}>({op:'save',actor,revision:initial.revision,connectionName:'Fictional HR mailbox',config:{...config,from:'separate-hr@example.test'},password:'fictional-profile-secret'});
 let selected=await internalEmailRequest<EmailSettingsView>({op:'view',actor,connectionId:saved.connectionId});
 const apply=()=>internalEmailRequest({op:'apply',actor,connectionId:saved.connectionId,draftId:selected.draft!.id,received:true,lifecycleSender:'hr'});
 await expect(apply()).rejects.toMatchObject({code:'needsTest'});await internalEmailRequest({op:'test',actor,connectionId:saved.connectionId,draftId:selected.draft!.id},async()=>{});
 await expect(internalEmailRequest({op:'apply',actor,connectionId:saved.connectionId,draftId:selected.draft!.id,received:false,lifecycleSender:'hr'})).rejects.toMatchObject({code:'needsReceipt'});await apply();
 const bound=await readLifecycleRelayTx(client,base.tenantId,'hr');expect(bound?.relay.config.from).toBe('separate-hr@example.test');expect(bound?.revision).not.toBe(original?.revision);expect(await readActiveRelayTx(client)).toEqual(original);
 expect(await readLifecycleRelayTx(client,base.tenantId,'onboarding')).toEqual(original);expect(await readLifecycleRelayTx(client,randomUUID(),'hr')).toEqual(original);
 selected=await internalEmailRequest<EmailSettingsView>({op:'view',actor,connectionId:saved.connectionId});
 await internalEmailRequest({op:'save',actor,revision:selected.revision,connectionId:saved.connectionId,connectionName:'Fictional HR mailbox',config:{...config,from:'future-hr@example.test'},password:'fictional-future-secret'});
 expect(await readLifecycleRelayTx(client,base.tenantId,'hr')).toEqual(bound);const visible=await view();expect(visible.lifecycleSenders?.find(sender=>sender.profile==='hr')).toMatchObject({from:'separate-hr@example.test',hasUnappliedChanges:true});
 expect(JSON.stringify(visible)).not.toContain('fictional-profile-secret');expect(JSON.stringify(await owner.client`select * from app_internal_auth_record`)).not.toContain('fictional-profile-secret');
 const events=await owner.client`select event_type,payload from domain_event where event_type='identity-email.lifecycle-sender-applied'`;expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({profile:'hr',connectionId:saved.connectionId});
});
