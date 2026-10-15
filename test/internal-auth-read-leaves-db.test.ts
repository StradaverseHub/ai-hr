/** Programmatic fixture evidence only; no human enrollment or SMTP acceptance claim. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { client } from '../db/client';
import { readRecord, writeRecord, deleteRecord, type AuthSql } from '../lib/internal-auth/record-store';
import { assertActiveCredential } from '../lib/internal-auth/credential';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { changeInitialPassword, credentialByLogin, startLogin, verifyMfa } from '../lib/internal-auth/service';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','7'.repeat(64));});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
describe('explicit transaction reads through real canonical private SQL',()=>{
  it('uses the restricted app role without exposing the private table and retains transaction rollback',async()=>{
    const [role]=await client`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role).toMatchObject({name:'ai_hr_app',rolsuper:false,rolbypassrls:false});
    const rollback=new Error('fixture rollback');
    await expect(client.begin(async raw=>{
      const tx=raw as unknown as AuthSql;
      await writeRecord(tx,'fixture:explicit-read',{secret:'synthetic-only'},null);
      expect(await readRecord(tx,'fixture:explicit-read',true)).toEqual({secret:'synthetic-only'});
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await readRecord(client,'fixture:explicit-read')).toBeNull();
    await expect(client`select * from app_internal_auth_record`).rejects.toThrow(/permission denied/);
  });
  it('holds the canonical record row lock in the caller transaction and releases it on completion',async()=>{
    await writeRecord(client,'fixture:locked-read',{version:'original'},null);
    let release!:()=>void,ready!:()=>void,rejectReady!:(error:unknown)=>void;
    const released=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;});
    const holding=client.begin(async raw=>{
      expect(await readRecord(raw as unknown as AuthSql,'fixture:locked-read',true)).toEqual({version:'original'});
      ready();await released;
    });
    void holding.catch(rejectReady);
    try{
      await started;
      await expect(client.begin(async raw=>{
        await raw`select set_config('lock_timeout','100ms',true)`;
        await writeRecord(raw as unknown as AuthSql,'fixture:locked-read',{version:'blocked'},null);
      })).rejects.toMatchObject({code:'55P03'});
    }finally{release();await holding;}
    expect(await readRecord(client,'fixture:locked-read')).toEqual({version:'original'});
    await writeRecord(client,'fixture:locked-read',{version:'after-release'},null);
    expect(await readRecord(client,'fixture:locked-read')).toEqual({version:'after-release'});
    await deleteRecord(client,'fixture:locked-read');
  });
  it('resolves the actual enrolled issuer/subject principal and refuses tenant/binding drift without changing version',async()=>{
    const temporary='Fictional temporary phrase 771!',final='Fictional replacement phrase 992!';
    await bootstrapInternalOwner(owner.client,{appUserId:base.adminUserId,organization:'leaves',username:'reader',email:'reader@example.test',password:temporary,installationOperator:false});
    const login=await startLogin({organization:'leaves',username:'reader',password:temporary,native:false});
    if(!('challenge' in login))throw new Error('Expected initial password challenge.');
    const setup=await changeInitialPassword(login.challenge,final);
    if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected fixture MFA enrollment.');
    expect((await verifyMfa(setup.challenge,await generate({secret:setup.secret}))).step).toBe('complete');
    const credential=(await credentialByLogin('leaves','reader'))!,before=structuredClone(credential);
    await client.begin(async raw=>{
      const tx=raw as unknown as AuthSql;
      expect(await assertActiveCredential(tx,credential)).toEqual({app_user_id:base.adminUserId,tenant_id:base.tenantId});
      await expect(assertActiveCredential(tx,{...credential,tenantId:'11111111-1111-4111-8111-111111111111'})).rejects.toMatchObject({code:'invalidLogin'});
    });
    await owner.client`update app_external_identity set revoked_at=now() where issuer=${credential.issuer} and subject=${credential.subject}`;
    await expect(assertActiveCredential(client,credential)).rejects.toMatchObject({code:'invalidLogin'});
    expect(credential).toEqual(before);expect((await credentialByLogin('leaves','reader'))?.version).toBe(before.version);
  });
});
