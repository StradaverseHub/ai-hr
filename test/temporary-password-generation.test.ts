import {describe,expect,it} from 'vitest';
import {temporaryPasswordForPolicy} from '../lib/internal-auth/password-policy';
import {DEFAULT_PASSWORD_POLICY,NEW_PASSWORD_REQUIREMENTS,passwordMeetsRequirements} from '../lib/password-policy';
describe('policy-aware temporary-password generation',()=>{
 it.each([[8,32],[80,100],[4,4]])('obeys inclusive %i–%i bounds and all requested classes', (minLength,maxLength)=>{
  const requirements={...NEW_PASSWORD_REQUIREMENTS,minLength,maxLength,uppercase:true,lowercase:true,numbers:true,special:true};
  for(let sample=0;sample<8;sample++){
   const password=temporaryPasswordForPolicy({...DEFAULT_PASSWORD_POLICY,requirements},'fictional.owner','owner@example.test');
   expect(passwordMeetsRequirements(password,requirements,'fictional.owner','owner@example.test')).toBe(true);
  }
 });
 it('fails closed for an impossible class/length policy and preserves the legacy password contract',()=>{
  expect(()=>temporaryPasswordForPolicy({...DEFAULT_PASSWORD_POLICY,requirements:{...NEW_PASSWORD_REQUIREMENTS,minLength:1,maxLength:3,uppercase:true,lowercase:true,numbers:true,special:true}},'fictional.owner','owner@example.test')).toThrow();
  const password=temporaryPasswordForPolicy(DEFAULT_PASSWORD_POLICY,'fictional.owner','owner@example.test');expect(password.length).toBeGreaterThanOrEqual(14);expect(password.length).toBeLessThanOrEqual(128);
 });
});
