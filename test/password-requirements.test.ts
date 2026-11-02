import {describe,it,expect,vi} from 'vitest';
import {NEW_PASSWORD_REQUIREMENTS,validatePasswordPolicy,passwordMeetsRequirements,passwordPolicyKey} from '../lib/password-policy';
const policy=(requirements={...NEW_PASSWORD_REQUIREMENTS})=>({enabled:false,interval:90,unit:'days' as const,requirements});
describe('tenant password requirements',()=>{
 it('validates all configured bounds and hierarchy without coercion',()=>{
  expect(validatePasswordPolicy(policy()).requirements).toEqual(NEW_PASSWORD_REQUIREMENTS);
  for(const requirements of [
   {...NEW_PASSWORD_REQUIREMENTS,minLength:33}, {...NEW_PASSWORD_REQUIREMENTS,maxLength:129},
   {...NEW_PASSWORD_REQUIREMENTS,historyCount:0},{...NEW_PASSWORD_REQUIREMENTS,failedAttempts:101},
   {...NEW_PASSWORD_REQUIREMENTS,unlockMinutes:0},{...NEW_PASSWORD_REQUIREMENTS,autoUnlock:true},
  ])expect(()=>validatePasswordPolicy(policy(requirements))).toThrow('invalid');
 });
 it('applies each optional complexity requirement and Unicode length independently',()=>{
  const base={...NEW_PASSWORD_REQUIREMENTS,minLength:3,maxLength:4};
  expect(passwordMeetsRequirements('😀😀😀',base)).toBe(true);
  expect(passwordMeetsRequirements('ab',base)).toBe(false);
  for(const [key,good,bad] of [['uppercase','aB1','abc'],['lowercase','Ab1','ABC'],['numbers','ab1','abc'],['special','ab!','abc']] as const){
   expect(passwordMeetsRequirements(good,{...base,[key]:true})).toBe(true);
   expect(passwordMeetsRequirements(bad,{...base,[key]:true})).toBe(false);
  }
  expect(passwordMeetsRequirements('ab\0',base)).toBe(false);
  expect(passwordMeetsRequirements('name',{...base,minLength:1},'name')).toBe(false);
 });
 it('enforces precise lock boundary and persists failures without exposing account state',async()=>{
  vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','4'.repeat(64));
  try{
   const {encryptRecord}=await import('../lib/internal-auth/crypto');
   const {admitPasswordAttempt,loginFailuresKey}=await import('../lib/internal-auth/login-lockout');
   const records=new Map<string,string>();
   const tx={unsafe:async(query:string,args:unknown[]=[])=>{
    const key=String(args[0]);
    if(query.includes('internal_auth_read'))return records.has(key)?[{sealed:records.get(key)}]:[];
    if(query.includes('internal_auth_write')){records.set(key,String(args[2]));return [];}
    if(query.includes('internal_auth_delete')){records.delete(key);return [];}
    throw Error('Unexpected query');
   }} as unknown as import('../lib/internal-auth/record-store').AuthSql;
   const c={subject:'subject-one',tenantId:'tenant-one'} as import('../lib/internal-auth/credential').Credential;
   const value=policy({...NEW_PASSWORD_REQUIREMENTS,lockoutEnabled:true,failedAttempts:2,autoUnlock:true,unlockMinutes:1});
   const key=passwordPolicyKey(c.tenantId);records.set(key,encryptRecord({policy:value,revision:1},key,null));
   expect(await admitPasswordAttempt(tx,c,false,1000)).toBe(false);
   expect(await admitPasswordAttempt(tx,c,false,2000)).toBe(false);
   expect(await admitPasswordAttempt(tx,c,true,61999)).toBe(false);
   expect(await admitPasswordAttempt(tx,c,true,62000)).toBe(true);
   expect(records.has(loginFailuresKey(c.subject))).toBe(false);
   value.requirements.autoUnlock=false;records.set(key,encryptRecord({policy:value,revision:2},key,null));
   await admitPasswordAttempt(tx,c,false,1000);await admitPasswordAttempt(tx,c,false,2000);
   expect(await admitPasswordAttempt(tx,c,true,10000000)).toBe(false);
   const other={...c,subject:'subject-two'};expect(await admitPasswordAttempt(tx,other,true,3000)).toBe(true);
  }finally{vi.unstubAllEnvs();}
 });
});

describe('configured bounded history',()=>{
 it('counts previous passwords in addition to current and releases older entries',async()=>{
  vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','4'.repeat(64));
  try{
   const {encryptRecord}=await import('../lib/internal-auth/crypto');
   const {replacePassword}=await import('../lib/internal-auth/password-policy');
   const records=new Map<string,string>();
   const tx={unsafe:async(query:string,args:unknown[]=[])=>{
    const key=String(args[0]);if(query.includes('internal_auth_read'))return records.has(key)?[{sealed:records.get(key)}]:[];
    if(query.includes('internal_auth_write')){records.set(key,String(args[2]));return [];}
    throw Error('Unexpected query');
   }} as unknown as import('../lib/internal-auth/record-store').AuthSql;
   const c={tenantId:'one',subject:'subject',username:'reader',email:'reader@test.invalid',password:null} as import('../lib/internal-auth/credential').Credential;
   const key=passwordPolicyKey(c.tenantId);records.set(key,encryptRecord({revision:1,policy:policy({...NEW_PASSWORD_REQUIREMENTS,historyEnabled:true,historyCount:1})},key,null));
   await replacePassword(tx,c,'Phrase alpha 1!');await replacePassword(tx,c,'Phrase beta 2!');
   for(const value of ['Phrase alpha 1!','Phrase beta 2!'])await expect(replacePassword(tx,c,value)).rejects.toMatchObject({code:'passwordPolicy'});
   await replacePassword(tx,c,'Phrase gamma 3!');await replacePassword(tx,c,'Phrase alpha 1!');
   expect(JSON.stringify([...records])).not.toContain('Phrase alpha 1!');
   records.set(key,encryptRecord({revision:2,policy:policy()},key,null));
   await expect(replacePassword(tx,c,'Phrase alpha 1!')).resolves.toBeUndefined();
  }finally{vi.unstubAllEnvs();}
 },20_000);
});
