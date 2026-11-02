import {describe,it,expect} from 'vitest';
import {assertDisposableDemoUrl,assertDisposableDemoIdentity,assertOwnedFixtureRows} from '../scripts/lib/disposable-demo-fixture';
const tenant='11111111-1111-1111-1111-111111111111';
describe('fixture target and exact-owned data admission',()=>{
 it('admits only explicit fixture loopback targets with no authority-changing URL options',()=>{
  const allowed='postgres://fixture_owner:fictional@127.0.0.1:5433/ai_hr_fixture_onehr';
  expect(assertDisposableDemoUrl(allowed,'onehr').database).toBe('ai_hr_fixture_onehr');
  for(const value of ['postgres://x:y@customer.invalid:5433/ai_hr_fixture_onehr','postgres://x:y@127.0.0.1:5433/customer','postgres://x:y@127.0.0.1:5433/ai_hr_fixture_onehr?options=-csearch_path%3Dhostile','not-a-url'])expect(()=>assertDisposableDemoUrl(value,'onehr')).toThrow(/disposable fixture target/i);
 });
 it('checks actual database/owner identity and refuses coexisting foreign tenants',()=>{
  const admitted=assertDisposableDemoUrl('postgres://fixture_owner:fake@127.0.0.1:5433/ai_hr_fixture_pooled_leave','pooled-leave');
  expect(()=>assertDisposableDemoIdentity(admitted,{database:admitted.database,user:'fixture_owner',tenants:[tenant]})).not.toThrow();
  for(const change of [{database:'foreign'},{user:'another_owner'},{tenants:[tenant,'22222222-2222-2222-2222-222222222222']}])expect(()=>assertDisposableDemoIdentity(admitted,{database:admitted.database,user:'fixture_owner',tenants:[tenant],...change})).toThrow();
 });
 it('cleanup matches complete owned rows, not shared date/type/name or merely equal counts',()=>{
  const original=[{id:'owned',tenant_id:tenant,start_date:'2026-01-12',days:'2.00'}];
  expect(()=>assertOwnedFixtureRows(original,structuredClone(original))).not.toThrow();
  expect(()=>assertOwnedFixtureRows(original,[{...original[0],id:'foreign'}])).toThrow();
  expect(()=>assertOwnedFixtureRows(original,[{...original[0],days:'3.00'}])).toThrow();
  expect(()=>assertOwnedFixtureRows(original,[])).toThrow();
 });
});
