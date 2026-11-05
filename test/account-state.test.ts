import {describe,it,expect} from 'vitest';
import {accountAvailable,temporaryPasswordAvailable} from '../lib/internal-auth/account-state';
describe('account admission calendar',()=>{
 it('keeps the final Malaysia day inclusive across UTC midnight boundaries',()=>{
  const c={enabled:true,accountActiveUntil:'2026-11-04'};
  expect(accountAvailable(c,new Date('2026-11-04T15:59:59Z'))).toBe(true);
  expect(accountAvailable(c,new Date('2026-11-04T16:00:00Z'))).toBe(false);
 });
 it('refuses suspension and disabled provisioning independently of date',()=>{
  expect(accountAvailable({enabled:true,suspended:true,accountActiveUntil:null})).toBe(false);
  expect(accountAvailable({enabled:false,accountActiveUntil:null})).toBe(false);
  expect(accountAvailable({enabled:true,accountActiveUntil:null})).toBe(true);
 });
 it('expires temporary passwords at the exact deadline and keeps legacy credentials compatible',()=>{
  expect(temporaryPasswordAvailable({},100)).toBe(true);
  expect(temporaryPasswordAvailable({temporaryPasswordExpiresAt:100},99)).toBe(true);
  expect(temporaryPasswordAvailable({temporaryPasswordExpiresAt:100},100)).toBe(false);
 });
});
