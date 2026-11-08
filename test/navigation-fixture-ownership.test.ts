/** Pure constructor/readback comparisons. Actual500 native ownership is a separate proof. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {assertNavigationFixtureSeedOwnership} from '../scripts/performance/navigation-fixture-ownership';
import {fictionalNavigationFixture,navigationFixtureUuid as uuid} from './helpers/navigation-fixture';
function inputs(){const fixture=fictionalNavigationFixture();return {...fixture,rows:fixture.users.map(u=>({userId:u.userId,tenantId:u.tenantId,personId:u.personId,employmentId:u.employmentId,companyId:u.companyId,name:u.name,employeeCode:'PERF'+String(u.index).padStart(4,'0')}))};}
it('checks all500 original native identity pairs against independent constructor allocation and input names/codes',()=>{
 const {users,tenants,rows}=inputs();expect(()=>assertNavigationFixtureSeedOwnership(users,tenants,rows.reverse())).not.toThrow();
});
it('refuses missing/duplicate/foreign/mismatched actual ownership rows with value-free errors',()=>{
 const edits=[(v:ReturnType<typeof inputs>)=>v.rows.pop(),(v:ReturnType<typeof inputs>)=>v.rows.push({...v.rows[0]}),
  (v:ReturnType<typeof inputs>)=>{v.rows[1]={...v.rows[0]};},(v:ReturnType<typeof inputs>)=>{v.rows[0].tenantId=v.tenants[1].tenantId;},
  (v:ReturnType<typeof inputs>)=>{v.rows[0].companyId=v.tenants[1].companies[0].companyId;},(v:ReturnType<typeof inputs>)=>{v.rows[0].personId=v.rows[1].personId;},
  (v:ReturnType<typeof inputs>)=>{v.rows[0].employmentId=v.rows[1].employmentId;},(v:ReturnType<typeof inputs>)=>{v.rows[0].userId=uuid(999999);},
  (v:ReturnType<typeof inputs>)=>{v.rows[0].name='PRIVATE_NATIVE_NAME';},(v:ReturnType<typeof inputs>)=>{v.rows[0].employeeCode='PRIVATE_NATIVE_CODE';}];
 for(const edit of edits){const v=inputs();edit(v);let error:unknown;try{assertNavigationFixtureSeedOwnership(v.users,v.tenants,v.rows);}catch(caught){error=caught;}
  expect(error).toBeInstanceOf(Error);const text=String(error);expect(text).not.toMatch(/00000001|PRIVATE_NATIVE|PERF Person|select |params|NEVER_EXPORT/);}
});
it('refuses incomplete or forged constructor allocation instead of accepting matching forged readback',()=>{
 for(const edit of [(v:ReturnType<typeof inputs>)=>{v.users[0].tenantId=v.tenants[1].tenantId;v.rows[0].tenantId=v.tenants[1].tenantId;},
  (v:ReturnType<typeof inputs>)=>{v.users[0].personId=v.users[1].personId;},(v:ReturnType<typeof inputs>)=>{v.tenants[1].tenantId=v.tenants[0].tenantId;},
  (v:ReturnType<typeof inputs>)=>{v.users[1].index=0;},(v:ReturnType<typeof inputs>)=>{v.users[0].role='employee';}]){
  const v=inputs();edit(v);expect(()=>assertNavigationFixtureSeedOwnership(v.users,v.tenants,v.rows)).toThrow();
 }
});
it('pins the actual producer tenant closure and one bounded existing-connection read before its private publish',()=>{
 const source=readFileSync(new URL('../scripts/performance/system-fixture.mjs',import.meta.url),'utf8');
 expect(source).toContain('users.push({index,tenant:t,tenantId:b.tenantId,company:c');
 const begin=source.indexOf("await fixturePhase(null,'navigation-seed-ownership'");expect(begin).toBeGreaterThan(0);
 const check=source.slice(begin,source.indexOf("const fixturePath=",begin));
 expect(check.match(/owner\.client`/g)).toHaveLength(1);expect(check).toContain('order by u.id,e.id limit 501');
 for(const join of ['p.tenant_id=u.tenant_id','e.tenant_id=p.tenant_id','c.tenant_id=e.tenant_id'])expect(check).toContain(join);
 expect(check).toContain('assertNavigationFixtureSeedOwnership(users,tenants,rows)');expect(check).not.toMatch(/writeFile|console|JSON\.stringify|createPool|new Pool/);
 expect(source.indexOf('assertNavigationFixtureSeedOwnership(users,tenants,rows)')).toBeLessThan(source.indexOf('writeFileSync(fixturePath'));
});
