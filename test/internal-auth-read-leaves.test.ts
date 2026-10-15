/** Explicit-Tx SQL is captured; encryption and credential checks are real. No connection is opened. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const singleton = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock('../db/client', () => ({ client: singleton }));
import * as legacyStore from '../lib/internal-auth/store';
import * as legacyService from '../lib/internal-auth/service';
import { readRecord, writeRecord, deleteRecord, revokeCredentialsSessions, type AuthSql } from '../lib/internal-auth/record-store';
import { assertActiveCredential, type Credential } from '../lib/internal-auth/credential';
import { InternalAuthError } from '../lib/internal-auth/errors';
import { readActiveRelayTx } from '../lib/internal-auth/active-relay';
import { decryptRecord, encryptRecord } from '../lib/internal-auth/crypto';

const credential: Credential = { subject:'11111111-1111-4111-8111-111111111111', tenantId:'22222222-2222-4222-8222-222222222222',
  issuer:'https://hr.test/auth/22222222-2222-4222-8222-222222222222', organization:'fictional', username:'reader', email:'reader@example.test',
  emailVerified:true, enabled:true, password:'existing-hash-is-not-rehashed', mustChange:false, version:'33333333-3333-4333-8333-333333333333',
  totpSecret:'existing-secret-is-not-verified-again', lastStep:9, recoveryHashes:['existing-hash'] };
function captured(rows: unknown[] = []) {
  const unsafe = vi.fn(async () => rows);
  return { unsafe, tx: { unsafe } as unknown as AuthSql };
}
beforeEach(() => { vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY','1'.repeat(64)); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());

describe('canonical record IO extraction', () => {
  it('keeps legacy exports as the same functions and preserves the singleton advisory wrapper', async () => {
    expect(legacyStore.readRecord).toBe(readRecord); expect(legacyStore.writeRecord).toBe(writeRecord);
    expect(legacyStore.deleteRecord).toBe(deleteRecord); expect(legacyStore.revokeCredentialsSessions).toBe(revokeCredentialsSessions);
    const {tx,unsafe}=captured(); singleton.begin.mockImplementation(async fn => fn(tx));
    await expect(legacyStore.authTransaction('fixed-subject', async given => { expect(given).toBe(tx); return 'same-result'; })).resolves.toBe('same-result');
    expect(unsafe).toHaveBeenCalledWith("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))",['fixed-subject']);
  });
  it('returns null only for missing/expired records and forwards the exact SQL key/lock', async () => {
    expect(await readRecord(captured().tx,'credential:missing')).toBeNull();
    const expired=captured([{sealed:encryptRecord({value:'expired'},'credential:one',Date.now()-1)}]);
    expect(await readRecord(expired.tx,'credential:one',true)).toBeNull();
    expect(expired.unsafe).toHaveBeenCalledWith('select sealed from app.internal_auth_read($1,$2)',['credential:one',true]);
    const live=captured([{sealed:encryptRecord({value:'unchanged'},'credential:one',null)}]);
    expect(await readRecord(live.tx,'credential:one')).toEqual({value:'unchanged'});
    expect(live.unsafe).toHaveBeenCalledWith('select sealed from app.internal_auth_read($1,$2)',['credential:one',false]);
  });
  it('retains AAD, wrong-key, tamper and sealed-size refusal instead of converting them to absence', async () => {
    const sealed=encryptRecord({value:'private'},'credential:one',null);
    await expect(readRecord(captured([{sealed}]).tx,'credential:two')).rejects.toThrow();
    const bytes=Buffer.from(sealed,'base64url'); bytes[bytes.length-1]^=1;
    await expect(readRecord(captured([{sealed:bytes.toString('base64url')}]).tx,'credential:one')).rejects.toThrow();
    await expect(readRecord(captured([{sealed:'A'.repeat(65537)}]).tx,'credential:one')).rejects.toThrow();
    vi.stubEnv('AUTH_SESSION_KEY','2'.repeat(64));
    await expect(readRecord(captured([{sealed}]).tx,'credential:one')).rejects.toThrow();
  });
  it('propagates the original SQL error without treating failed storage as an absent identity', async () => {
    const failure=new Error('synthetic database unavailable'),{tx,unsafe}=captured();
    unsafe.mockRejectedValueOnce(failure);
    await expect(readRecord(tx,'credential:one')).rejects.toBe(failure);
  });
  it('preserves authenticated write format, owner/expiry binding and delete/revoke SQL', async () => {
    const {tx,unsafe}=captured(),expires=Date.now()+10000;
    await writeRecord(tx,'credential:one',{private:'synthetic-secret'},credential.subject,expires);
    const [statement,args]=unsafe.mock.calls[0] as unknown as [string,unknown[]];
    expect(statement).toBe('select app.internal_auth_write($1,$2::uuid,$3,$4::timestamptz)');
    expect(args[0]).toBe('credential:one');expect(args[1]).toBe(credential.subject);expect(args[3]).toBe(new Date(expires).toISOString());
    expect(String(args[2])).not.toContain('synthetic-secret');expect(decryptRecord(String(args[2]),'credential:one')).toEqual({private:'synthetic-secret'});
    await writeRecord(tx,'email-state',{active:null},null);
    expect((unsafe.mock.calls[1] as unknown as [string,unknown[]])[1][3]).toBeNull();
    await deleteRecord(tx,'credential:one');await revokeCredentialsSessions(tx,credential.subject);
    expect(unsafe).toHaveBeenCalledWith('select app.internal_auth_delete($1)',['credential:one']);
    expect(unsafe).toHaveBeenCalledWith('select app.internal_auth_revoke($1::uuid)',[credential.subject]);
  });
});

describe('same canonical credential and error authority', () => {
  it('retains exact function/class identities and resolves only the supplied issuer/subject tuple', async () => {
    expect(legacyService.InternalAuthError).toBe(InternalAuthError);expect(legacyService.assertActiveCredential).toBe(assertActiveCredential);
    const user='44444444-4444-4444-8444-444444444444',{tx,unsafe}=captured([{app_user_id:user,tenant_id:credential.tenantId}]);
    const before=structuredClone(credential);
    expect(await assertActiveCredential(tx,credential)).toEqual({app_user_id:user,tenant_id:credential.tenantId});
    expect(unsafe).toHaveBeenCalledWith('select app_user_id,tenant_id from app.principal_by_identity($1,$2)',[credential.issuer,credential.subject]);
    expect(credential).toEqual(before); // No version change, factor consumption, KDF or default insertion.
  });
  it.each([{enabled:false},{password:null},{mustChange:true},{totpSecret:null},{emailVerified:false}])('refuses the existing inactive flags before any lookup: %j', async patch => {
    const {tx,unsafe}=captured([{app_user_id:'user',tenant_id:credential.tenantId}]);
    const rejected=assertActiveCredential(tx,{...credential,...patch});
    await expect(rejected).rejects.toBeInstanceOf(legacyService.InternalAuthError);
    await expect(rejected).rejects.toMatchObject({code:'invalidLogin'});expect(unsafe).not.toHaveBeenCalled();
  });
  it.each([{rows:[]},{rows:[{app_user_id:'user',tenant_id:'another-tenant'}]},{rows:[{app_user_id:null,tenant_id:credential.tenantId}]}])('refuses missing, cross-tenant or invalid canonical principal: %j', async ({rows}) => {
    await expect(assertActiveCredential(captured(rows).tx,credential)).rejects.toBeInstanceOf(InternalAuthError);
  });
});

describe('fixed active SMTP projection', () => {
  const config={host:'smtp.example.test',port:465,security:'tls',from:'owner@example.test',fromName:'AI HR',replyTo:'',auth:true,user:'relay'};
  const read=(state:unknown,lock=false)=>{const io=captured([{sealed:encryptRecord(state,'email-state',null)}]);return {io,result:readActiveRelayTx(io.tx,lock)};};
  it('reads only the canonical state, retaining lock choice and excluding every operator draft', async () => {
    const {io,result}=read({revision:'R'.repeat(43),active:{config,password:'active-secret'},drafts:{operator:{password:'draft-secret',arbitrary:'not-returned'}}},true);
    expect(await result).toEqual({revision:'R'.repeat(43),relay:{config,password:'active-secret'}});
    expect(io.unsafe).toHaveBeenCalledWith('select sealed from app.internal_auth_read($1,$2)',['email-state',true]);
    expect(JSON.stringify(await result)).not.toContain('draft');
  });
  it('never promotes a draft and retains missing/expired/no-active absence', async () => {
    expect(await readActiveRelayTx(captured().tx)).toBeNull();
    expect(await read({revision:'initial',active:null,drafts:{operator:{config,password:'draft-secret'}}}).result).toBeNull();
    const expired=captured([{sealed:encryptRecord({revision:'initial',active:null},'email-state',Date.now()-1)}]);
    expect(await readActiveRelayTx(expired.tx)).toBeNull();
  });
  it.each([
    {config}, {config,password:'x'.repeat(4097)}, {config:{...config,security:'none'},password:'secret'},
    {config,password:'secret',path:'/tmp/relay'}, {config:{...config,host:''},password:'secret'},
  ])('refuses invalid active material without falling back to a draft', async active => {
    await expect(read({revision:'R'.repeat(43),active,drafts:{operator:{config,password:'draft-secret'}}}).result).rejects.toMatchObject({code:'invalid'});
  });
  it('refuses malformed revision and preserves storage errors', async () => {
    await expect(read({revision:'forged',active:{config,password:'secret'}}).result).rejects.toMatchObject({code:'invalid'});
    await expect(readActiveRelayTx(captured([{sealed:encryptRecord({},'different-purpose',null)}]).tx)).rejects.toThrow();
  });
});

it('keeps the complete runtime leaf import graph free of connection/session owners', () => {
  const root=fileURLToPath(new URL('..',import.meta.url)),visited=new Set<string>();
  const visit=(file:string)=>{
    if(visited.has(file))return;visited.add(file);
    const source=readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    for(const statement of tree.statements){
      if(!ts.isImportDeclaration(statement)&&!ts.isExportDeclaration(statement))continue;
      if(ts.isImportDeclaration(statement)&&(statement.importClause?.isTypeOnly||statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings)&&!statement.importClause.name&&statement.importClause.namedBindings.elements.every(e=>e.isTypeOnly)))continue;
      if(ts.isExportDeclaration(statement)&&statement.isTypeOnly)continue;
      if(!statement.moduleSpecifier||!ts.isStringLiteral(statement.moduleSpecifier))continue;
      const name=statement.moduleSpecifier.text;
      expect(name).not.toMatch(/db\/client|web-session|(?:^|\/)session$|^next|^postgres$/);
      if(name.startsWith('.'))visit(resolve(dirname(file),name+'.ts'));
      else expect(['node:crypto','node:url','node:net','zod']).toContain(name);
    }
  };
  for(const name of ['record-store','credential','errors','active-relay'])visit(root+'/lib/internal-auth/'+name+'.ts');
  expect([...visited].some(path=>path.endsWith('/db/client.ts'))).toBe(false);
});
