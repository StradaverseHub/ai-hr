import { randomBytes, randomInt } from 'node:crypto';
import type { Credential } from './credential';
import { readRecord, writeRecord, type AuthSql } from './record-store';
import { passwordHash, passwordMatches, passwordHistoryFingerprint, validatePassword } from './crypto';
import { InternalAuthError } from './errors';
import { DEFAULT_PASSWORD_POLICY, passwordExpired, passwordPolicyKey, validatePasswordPolicy, passwordMeetsRequirements, type PasswordPolicyState, type PasswordPolicy } from '../password-policy';

export async function passwordChangeRequired(tx: AuthSql, c: Credential) {
  if (c.mustChange) return true;
  const state = await readRecord<PasswordPolicyState>(tx, passwordPolicyKey(c.tenantId));
  return passwordExpired(c.passwordChangedAt, state ? validatePasswordPolicy(state.policy) : DEFAULT_PASSWORD_POLICY);
}
export async function effectivePasswordPolicy(tx:AuthSql,tenantId:string):Promise<PasswordPolicy> {
 const state=await readRecord<PasswordPolicyState>(tx,passwordPolicyKey(tenantId));
 return state?validatePasswordPolicy(state.policy):DEFAULT_PASSWORD_POLICY;
}
/** Cryptographic candidates obey the same configured bounds/classes as manually entered passwords.
 * Bounded retries cover identifier exclusions; impossible class/length combinations fail closed. */
export function temporaryPasswordForPolicy(policy:PasswordPolicy,username:string,email:string):string {
 const r=policy.requirements;
 const classes=[...(r?.uppercase?['ABCDEFGHIJKLMNOPQRSTUVWXYZ']:[]),...(r?.lowercase?['abcdefghijklmnopqrstuvwxyz']:[]),...(r?.numbers?['0123456789']:[]),...(r?.special?['!@#$%&*+-=?']:[])];
 const max=r?.maxLength??128,min=r?.minLength??14;
 if(classes.length>max)throw new InternalAuthError('passwordPolicy');
 const length=Math.max(min,classes.length,Math.min(32,max)),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*+-=?';
 for(let attempt=0;attempt<8;attempt++){
  const chars=classes.map(characters=>characters[randomInt(characters.length)]);
  while(chars.length<length)chars.push(alphabet[randomInt(alphabet.length)]);
  for(let index=chars.length-1;index>0;index--){const other=randomInt(index+1);[chars[index],chars[other]]=[chars[other],chars[index]];}
  const password=chars.join('');
  if(r){if(passwordMeetsRequirements(password,r,username,email))return password;}
  else{try{validatePassword(password,username,email);return password;}catch{/* Retry an excluded identifier. */}}
 }
 throw new InternalAuthError('passwordPolicy');
}
export async function generateTemporaryPassword(tx:AuthSql,c:Pick<Credential,'tenantId'|'username'|'email'>){
 return temporaryPasswordForPolicy(await effectivePasswordPolicy(tx,c.tenantId),c.username,c.email);
}
export async function validateTenantPassword(tx:AuthSql,c:Pick<Credential,'tenantId'|'username'|'email'>,password:string) {
 const policy=await effectivePasswordPolicy(tx,c.tenantId);
 try { if(policy.requirements){if(!passwordMeetsRequirements(password,policy.requirements,c.username,c.email))throw Error();}else validatePassword(password,c.username,c.email); }
 catch {throw new InternalAuthError('passwordPolicy');}
 return policy;
}
type History = { salt: string; legacyHash: string | null; currentFingerprint?:string; fingerprints?:string[]; legacyDepth?:number };
/** Caller holds the subject's advisory lock and persists the credential in this transaction.
 * A per-subject random history salt is encrypted with the existing auth store. Separate permanent
 * markers keep lookup cost/storage per change bounded without retaining plaintext or trimming history.
 * The original scrypt hash covers the one password whose plaintext predates history tracking. */
export async function replacePassword(tx: AuthSql, c: Credential, password: string) {
  const policy=await validateTenantPassword(tx,c,password);
  if(policy.requirements){
    const historyKey=`password-history:${c.subject}`;
    const stored=await readRecord<History>(tx,historyKey,true);
    const configured=stored?.currentFingerprint!==undefined;
    const salt=stored?.salt??randomBytes(32).toString('hex');
    const fingerprint=await passwordHistoryFingerprint(password,salt);
    const fingerprints=configured?stored.fingerprints??[]:[];
    const legacyHash=configured?stored.legacyHash:c.password;
    const legacyDepth=configured?stored.legacyDepth??1:0;
    if(policy.requirements.historyEnabled && (
      c.password&&await passwordMatches(password,c.password) ||
      fingerprints.slice(0,policy.requirements.historyCount).includes(fingerprint) ||
      legacyHash&&legacyHash!==c.password&&legacyDepth<=policy.requirements.historyCount&&await passwordMatches(password,legacyHash)
    ))throw new InternalAuthError('passwordPolicy');
    const next=[...(configured?[stored.currentFingerprint!]:[]),...fingerprints].slice(0,100);
    c.password=await passwordHash(password);c.passwordChangedAt=Date.now();
    await writeRecord(tx,historyKey,{salt,currentFingerprint:fingerprint,fingerprints:next,
      legacyHash:legacyDepth<100?legacyHash:null,legacyDepth:legacyDepth+1},c.subject);
    return;
  }
  const historyKey = `password-history:${c.subject}`;
  const history = await readRecord<History>(tx, historyKey, true) ?? { salt: randomBytes(32).toString('hex'), legacyHash: c.password };
  const fingerprint = await passwordHistoryFingerprint(password, history.salt);
  const marker = `password-used:${c.subject}:${fingerprint}`;
  if (await readRecord(tx, marker) ||
      (c.password && await passwordMatches(password, c.password)) ||
      (history.legacyHash && history.legacyHash !== c.password && await passwordMatches(password, history.legacyHash))) {
    throw new InternalAuthError('passwordPolicy');
  }
  c.password = await passwordHash(password);
  c.passwordChangedAt = Date.now();
  await writeRecord(tx, historyKey, history, c.subject);
  await writeRecord(tx, marker, { used: true }, c.subject);
}
