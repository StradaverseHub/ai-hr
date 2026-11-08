/** Pure comparisons for private fictional constructor inputs/readback; never login authority.
 * Error messages deliberately contain no row, identifier or SQL parameter values. */
import assert from 'node:assert/strict';
import {fixtureNavigationActor} from './navigation-protocol';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const validUuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
export function assertNavigationFixtureSeedOwnership(users:readonly any[],tenants:readonly any[],rows:readonly any[]):void{
 assert(Array.isArray(users)&&users.length===500&&Array.isArray(tenants)&&tenants.length===2,'Fictional fixture ownership population differs');
 assert(tenants.every(t=>t&&validUuid(t.tenantId)&&Array.isArray(t.companies)&&t.companies.length===5)
  &&new Set(tenants.map(t=>t.tenantId)).size===2,'Fictional fixture tenant ownership differs');
 const companies=tenants.flatMap(t=>t.companies.map((c:any)=>c.companyId));
 assert(companies.every(id=>validUuid(id))&&new Set(companies).size===10,'Fictional fixture company ownership differs');
 const expected=new Map<string,any>(),indices=new Set<number>();
 const unique={employmentId:new Set<string>(),personId:new Set<string>(),userId:new Set<string>()};
 for(const user of users){
  const actor=fixtureNavigationActor(user.index),tenant=Math.floor(user.index/250),company=Math.floor((user.index%250)/50);
  assert(!indices.has(user.index)&&user.tenant===tenant&&user.company===company&&user.tenantId===tenants[tenant].tenantId
   &&user.companyId===tenants[tenant].companies[company].companyId&&user.name===actor.name&&user.role===actor.role,'Fictional fixture actor ownership differs');
  for(const field of ['employmentId','personId','userId']as const){assert(validUuid(user[field])&&!unique[field].has(user[field]),'Fictional fixture native identity differs');unique[field].add(user[field]);}
  indices.add(user.index);expected.set(user.userId,user);
 }
 assert(indices.size===500&&Array.from({length:500},(_,i)=>i).every(i=>indices.has(i)),'Fictional fixture input identity census differs');
 assert(Array.isArray(rows)&&rows.length===500,'Fictional fixture native ownership census differs');
 const seen=new Set<string>();
 for(const row of rows){
  const user=expected.get(row?.userId);
  assert(user&&!seen.has(row.userId)&&Object.keys(row).sort().join('|')==='companyId|employeeCode|employmentId|name|personId|tenantId|userId'
   &&row.tenantId===user.tenantId&&row.companyId===user.companyId&&row.personId===user.personId&&row.employmentId===user.employmentId
   &&row.name===user.name&&row.employeeCode==='PERF'+String(user.index).padStart(4,'0'),'Fictional fixture native ownership differs');
  seen.add(row.userId);
 }
 assert(seen.size===500,'Fictional fixture native ownership incomplete');
}
