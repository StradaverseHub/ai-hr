/** Actual server action/admission/renderer; synthetic session, database and mail transport ports only. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
const ports=vi.hoisted(()=>({session:vi.fn(),identity:vi.fn(),internal:vi.fn(),tenant:vi.fn(),execute:vi.fn(),send:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:ports.session}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:ports.identity}));
vi.mock('../lib/internal-auth/config',()=>({internalSelected:ports.internal,internalConfig:()=>({origin:'https://hr.example.test'})}));
vi.mock('../lib/internal-auth/mail',()=>({sendInternalMail:ports.send}));
vi.mock('../db/client',()=>({withTenant:ports.tenant}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
import {sendEmailDesignTestAction} from '../app/(app)/admin/settings/email-templates/actions';
import {defaultEmailDocument} from '../lib/email-design/model';
import {renderEmailDesign} from '../lib/email-design/render';
import {sampleEmailSystem} from '../lib/email-design/catalogue';
import {sampleEmailData} from '../lib/email-design/sample-data';
const ctx={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
const identity={issuer:'https://hr.example.test/auth/'+ctx.tenantId,subject:'33333333-3333-4333-8333-333333333333',email:'signed-in-admin@example.test',emailVerified:true};
const principal={app_user_id:ctx.userId,tenant_id:ctx.tenantId};
const document=()=>({...defaultEmailDocument('invitation'),subject:'Fictional approved test'});
const dialect=new PgDialect();
const query=(index:number)=>dialect.sqlToQuery(ports.execute.mock.calls[index][0]);
beforeEach(()=>{
 vi.resetAllMocks();ports.session.mockResolvedValue(ctx);ports.identity.mockResolvedValue(identity);ports.internal.mockReturnValue(true);
 ports.tenant.mockImplementation(async(_ctx:unknown,run:(tx:unknown)=>unknown)=>run({execute:ports.execute}));
 // Execute the actual listEmailDesigns admission first, then the exact identity binding lookup.
 ports.execute.mockResolvedValueOnce([{allowed:true}]).mockResolvedValueOnce([]).mockResolvedValueOnce([principal]);
 ports.send.mockResolvedValue(undefined);
});
describe('Email designer authenticated test-to-self action',()=>{
 it('checks live admission and exact issuer/subject under the same tenant before sending both rendered alternatives only to self',async()=>{
  const doc=document();expect(await sendEmailDesignTestAction('invitation','ms',doc)).toEqual({sent:true});
  expect(ports.tenant).toHaveBeenCalledTimes(2);
  for(const [session] of ports.tenant.mock.calls)expect(session).toBe(ctx);
  expect(query(0).sql).toContain('app.email_design_admin()');
  expect(query(2).sql).toContain('app.principal_by_identity(');expect(query(2).params).toEqual([identity.issuer,identity.subject]);
  expect(ports.send).toHaveBeenCalledExactlyOnceWith({to:identity.email,...renderEmailDesign(doc,'invitation','ms',sampleEmailSystem('invitation','ms'),sampleEmailData)});
  const mail=ports.send.mock.calls[0][0];expect(mail.html).toContain('https://example.com/aihr-preview');expect(mail.text).toContain('https://example.com/aihr-preview');
 });
 it('refuses a revoked live administrator grant before reading provider identity or sending',async()=>{
  ports.execute.mockReset().mockResolvedValueOnce([{allowed:false}]);
  await expect(sendEmailDesignTestAction('invitation','en',document())).rejects.toThrow('Email design permission required.');
  expect(ports.identity).not.toHaveBeenCalled();expect(ports.execute).toHaveBeenCalledOnce();expect(ports.send).not.toHaveBeenCalled();
 });
 it.each([null,{...identity,emailVerified:false},{...identity,email:''},{...identity,issuer:''}])('refuses absent or unverified provider identity before binding or SMTP: %j',async value=>{
  ports.identity.mockResolvedValue(value);
  await expect(sendEmailDesignTestAction('invitation','en',document())).rejects.toThrow('A verified email address');
  expect(ports.execute).toHaveBeenCalledTimes(2);expect(ports.send).not.toHaveBeenCalled();
 });
 it('refuses a compatibility provider even with a verified address',async()=>{
  ports.internal.mockReturnValue(false);
  await expect(sendEmailDesignTestAction('invitation','en',document())).rejects.toThrow('A verified email address');expect(ports.send).not.toHaveBeenCalled();
 });
 it.each([
  {name:'missing identity binding',rows:[]},
  {name:'another user binding',rows:[{...principal,app_user_id:'44444444-4444-4444-8444-444444444444'}]},
  {name:'another tenant binding',rows:[{...principal,tenant_id:'55555555-5555-4555-8555-555555555555'}]},
 ])('refuses $name before SMTP',async({rows})=>{
  ports.execute.mockReset().mockResolvedValueOnce([{allowed:true}]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
  await expect(sendEmailDesignTestAction('invitation','en',document())).rejects.toThrow('The signed-in identity changed.');
  expect(ports.execute).toHaveBeenCalledTimes(3);expect(query(2).sql).toContain('app.principal_by_identity(');expect(query(2).params).toEqual([identity.issuer,identity.subject]);
  expect(ports.send).not.toHaveBeenCalled();
 });
 it('looks up a forged issuer/subject as supplied and refuses its absent canonical binding',async()=>{
  const forged={...identity,issuer:'https://foreign.example.test/auth/tenant',subject:'forged-subject',email:'foreign@example.test'};ports.identity.mockResolvedValue(forged);
  ports.execute.mockReset().mockResolvedValueOnce([{allowed:true}]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  await expect(sendEmailDesignTestAction('invitation','en',document())).rejects.toThrow('The signed-in identity changed.');
  expect(query(2).params).toEqual([forged.issuer,forged.subject]);expect(ports.send).not.toHaveBeenCalled();
 });
 it('does not accept a recipient address hidden in the client document',async()=>{
  await expect(sendEmailDesignTestAction('invitation','en',{...document(),to:'other-person@example.test'})).rejects.toThrow();expect(ports.send).not.toHaveBeenCalled();
 });
});
