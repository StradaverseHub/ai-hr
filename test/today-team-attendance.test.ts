/**
 * Manager Today's "Your team today" read (packs/attendance team-today.ts), ported from the retired dashboard's
 * attendance card (owner decision, 12 Nov 2026), at the shape of a real group (docs/SCALE-AND-RELEASE-RULES.md rule 3):
 * 70 companies and 1,000 employments, every one with an attendance row today.
 *
 * - A manager counts only their own team (direct and indirect reports on current administrative lines), under
 *   "All companies" and under one company.
 * - Someone with no reports gets zeros, never another population; a report who manages others counts only theirs.
 * - The figures equal the old dashboard's per-status count applied to the same team on the same day, computed
 *   independently from the fixture.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {teamAttendanceToday} from '../packs/attendance/service';
import {closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000;
const STATUSES=['present','late','half_day','absent'] as const;
const statusOf=(n:number)=>STATUSES[n%4];
let b:Base,today:string,companyIds:string[],employmentIds:string[],personIds:string[];

/** Employment n (1-based) is in company (n-1)%70. */
const companyOf=(n:number)=>companyIds[(n-1)%COMPANIES];
async function fixture(){
 b=await seedBase();today=todayInKualaLumpur();
 const cp=randomUUID().slice(0,24),pp=randomUUID().slice(0,24),ep=randomUUID().slice(0,24);
 const id=(prefix:string,n:number)=>prefix+String(n).padStart(12,'0');
 companyIds=[b.companyId,...Array.from({length:COMPANIES-1},(_,i)=>id(cp,i+1))];
 personIds=Array.from({length:EMPLOYMENTS},(_,i)=>id(pp,i+1));employmentIds=Array.from({length:EMPLOYMENTS},(_,i)=>id(ep,i+1));
 await owner.client.begin(async tx=>{
  await tx`insert into company(id,tenant_id,legal_name) select (${cp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional Group '||lpad(n::text,3,'0')||' Sdn Bhd'
   from generate_series(1,${COMPANIES-1}::integer)n`;
  await tx`insert into person(id,tenant_id,full_name,primary_email) select (${pp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional team '||lpad(n::text,4,'0'),
   ${pp}||n::text||'@example.invalid' from generate_series(1,${EMPLOYMENTS}::integer)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
   select (${ep}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${pp}||lpad(n::text,12,'0'))::uuid,
    (${JSON.stringify(companyIds)}::jsonb->>((n-1)%${COMPANIES}))::uuid,'TEAM'||lpad(n::text,4,'0'),'2026-01-01'::date from generate_series(1,${EMPLOYMENTS}::integer)n`;
  await tx`insert into attendance(tenant_id,employment_id,attendance_date,status,day_type)
   select ${b.tenantId}::uuid,(${ep}||lpad(n::text,12,'0'))::uuid,${today}::date,
    (array['present','late','half_day','absent'])[1+(n%4)]::attendance_status,'workday' from generate_series(1,${EMPLOYMENTS}::integer)n`;
 });
 // Employment 1 manages 2..11 directly; employment 2 manages 12..16, so 1's team is 2..16 (15 people).
 const line=(manager:number,subordinate:number)=>({tenantId:b.tenantId,managerEmploymentId:employmentIds[manager-1],
  subordinateEmploymentId:employmentIds[subordinate-1],lineType:'administrative' as const,validFrom:'2026-01-01'});
 const {reportingLine}=await import('../db/schema');
 await owner.db.insert(reportingLine).values([...Array.from({length:10},(_,i)=>line(1,i+2)),...Array.from({length:5},(_,i)=>line(2,i+12))]);
}
async function login(n:number,role:'employee'|'manager'):Promise<SessionContext>{
 const userId=await createAppUser(b.tenantId,personIds[n-1],role);
 return {tenantId:b.tenantId,userId,personId:personIds[n-1],roles:[role],grants:[{role,companyId:null}]} as SessionContext;
}
/** The old dashboard's count (one row per status for the day), applied to a given population, from the fixture alone. */
function expected(members:readonly number[]){
 const n=(status:string)=>members.filter(m=>statusOf(m)===status).length;
 return {date:today,present:n('present'),late:n('late'),halfDay:n('half_day'),absent:n('absent')};
}
const range=(from:number,to:number)=>Array.from({length:to-from+1},(_,i)=>from+i);

beforeAll(migrateTestDb,120000);
afterAll(closeAll);
beforeEach(async()=>{await resetDb();await fixture();},120000);

describe('teamAttendanceToday',()=>{
 it('counts only the manager\'s own team, under "All companies" and under one company',async()=>{
  const manager=await login(1,'manager');
  const all=await teamAttendanceToday(manager,{date:today,scopeIds:[]});
  expect(all).toEqual(expected(range(2,16)));
  expect(all.present+all.late+all.halfDay+all.absent).toBe(15);
  // Every company named explicitly is the same population as "All companies".
  expect(await teamAttendanceToday(manager,{date:today,scopeIds:companyIds})).toEqual(all);
  // One company: only the team members employed there.
  const one=companyOf(2);
  expect(await teamAttendanceToday(manager,{date:today,scopeIds:[one]})).toEqual(expected(range(2,16).filter(n=>companyOf(n)===one)));
  // A company with none of the team counts nothing.
  const none=companyIds.find(company=>!range(2,16).some(n=>companyOf(n)===company))!;
  expect(await teamAttendanceToday(manager,{date:today,scopeIds:[none]})).toEqual(expected([]));
 },60000);
 it('gives a report who manages others only their own team, and someone with no reports zeros',async()=>{
  expect(await teamAttendanceToday(await login(2,'manager'),{date:today,scopeIds:[]})).toEqual(expected(range(12,16)));
  expect(await teamAttendanceToday(await login(500,'employee'),{date:today,scopeIds:[]})).toEqual(expected([]));
  expect(await teamAttendanceToday(await login(16,'employee'),{date:today,scopeIds:[]})).toEqual(expected([]));
 },60000);
 it('counts the asked day only, and refuses a malformed day',async()=>{
  const manager=await login(1,'manager');
  expect(await teamAttendanceToday(manager,{date:'2026-01-02',scopeIds:[]})).toEqual({...expected([]),date:'2026-01-02'});
  expect(()=>teamAttendanceToday(manager,{date:'today',scopeIds:[]})).toThrow('A calendar day is required.');
 },60000);
});
