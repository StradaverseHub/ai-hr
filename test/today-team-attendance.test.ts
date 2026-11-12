/**
 * Manager Today's "Your team today" read (packs/attendance team-today.ts), ported from the retired dashboard's
 * attendance card (owner decision, 12 Nov 2026), at the shape of a real group (docs/SCALE-AND-RELEASE-RULES.md rule 3):
 * 70 companies and 1,000 employments, every one with an attendance row today.
 *
 * - A manager counts only their own team (direct and indirect reports on current administrative lines), under
 *   "All companies" and under one company. The team spans the manager's company and its subsidiary.
 * - A report in an unrelated company is not counted: row-level security lets a manager see reports only inside their
 *   own company subtree (app.is_admin_report_of, migration 0109), and this read adds no other path. (The first version
 *   of this fixture placed every report in a different unrelated company, so all of them were correctly invisible.)
 * - Someone with no reports gets zeros, never another population; a report who manages others counts only theirs.
 * - The figures equal the old dashboard's per-status count applied to the same team on the same day, computed
 *   independently from the fixture.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {teamAttendanceToday} from '../packs/attendance/service';
import {hireEmployee,setReportingLine} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {attendance as attendanceTable,reportingLine as reportingLineTable} from '../db/schema';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000,TEAM=16;
const STATUSES=['present','late','half_day','absent'] as const;
const statusOf=(n:number)=>STATUSES[n%4];
let b:Base,today:string,second:string,companyIds:string[],employmentIds:string[],personIds:string[];

/** Team member n (2..16) works in the seeded company when even, in its subsidiary when odd; the manager (1) in the
 * seeded company. The other 984 employments are spread over all 70 companies. */
const companyOf=(n:number)=>n<=TEAM?(n%2===0||n===1?b.companyId:second):companyIds[(n-1)%COMPANIES];
async function fixture(){
 b=await seedBase();today=todayInKualaLumpur();
 const admin=adminCtx(b);
 second=(await createCompany(admin,{legalName:'Fictional Subsidiary Team Sdn Bhd',parentCompanyId:b.companyId})).id;
 const secondDept=await createDepartment(admin,{companyId:second,name:'Fictional Second Department'});
 // The team, through the canonical hire and reporting-line owners (as the My Team suites build it).
 const team:{personId:string;employmentId:string}[]=[];
 for(let n=1;n<=TEAM;n++){
  const inSecond=companyOf(n)===second;
  team.push(await hireEmployee(admin,{person:{fullName:'Fictional team '+String(n).padStart(4,'0'),primaryEmail:randomUUID()+'@example.invalid'},
   companyId:inSecond?second:b.companyId,departmentId:inSecond?secondDept.id:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'}));
 }
 for(let n=2;n<=11;n++)await setReportingLine(admin,{subordinateEmploymentId:team[n-1].employmentId,managerEmploymentId:team[0].employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 for(let n=12;n<=16;n++)await setReportingLine(admin,{subordinateEmploymentId:team[n-1].employmentId,managerEmploymentId:team[1].employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 // The rest of the group, in bulk: 68 more companies and 984 more employments.
 const cp=randomUUID().slice(0,24),pp=randomUUID().slice(0,24),ep=randomUUID().slice(0,24);
 const id=(prefix:string,n:number)=>prefix+String(n).padStart(12,'0');
 companyIds=[b.companyId,second,...Array.from({length:COMPANIES-2},(_,i)=>id(cp,i+1))];
 const rest=EMPLOYMENTS-TEAM;
 await owner.client.begin(async tx=>{
  await tx`insert into company(id,tenant_id,legal_name) select (${cp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional Group '||lpad(n::text,3,'0')||' Sdn Bhd'
   from generate_series(1,${COMPANIES-2}::integer)n`;
  await tx`insert into person(id,tenant_id,full_name,primary_email) select (${pp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional group '||lpad(n::text,4,'0'),
   ${pp}||n::text||'@example.invalid' from generate_series(${TEAM+1}::integer,${EMPLOYMENTS}::integer)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
   select (${ep}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${pp}||lpad(n::text,12,'0'))::uuid,
    (${JSON.stringify(companyIds)}::jsonb->>((n-1)%${COMPANIES}))::uuid,'GROUP'||lpad(n::text,4,'0'),'2026-01-01'::date from generate_series(${TEAM+1}::integer,${EMPLOYMENTS}::integer)n`;
 });
 personIds=[...team.map(row=>row.personId),...Array.from({length:rest},(_,i)=>id(pp,TEAM+1+i))];
 employmentIds=[...team.map(row=>row.employmentId),...Array.from({length:rest},(_,i)=>id(ep,TEAM+1+i))];
 // A report of the manager employed by an unrelated group company (employment 17, company index 16): outside the
 // manager's company subtree, so row-level security keeps it out of the manager's view and out of the count.
 await owner.db.insert(reportingLineTable).values({tenantId:b.tenantId,subordinateEmploymentId:employmentIds[16],managerEmploymentId:employmentIds[0],
  lineType:'administrative',validFrom:'2026-01-01'});
 // Everyone has an attendance row today; employment n is recorded statusOf(n).
 await owner.db.insert(attendanceTable).values(employmentIds.map((employmentId,i)=>({tenantId:b.tenantId,employmentId,attendanceDate:today,
  status:statusOf(i+1),dayType:'workday' as const})));
 const [{count}]=await owner.client`select count(*)::int as count from employment where tenant_id=${b.tenantId}::uuid` as unknown as {count:number}[];
 expect(count).toBe(EMPLOYMENTS);
}
async function login(n:number,role:'employee'|'manager'):Promise<SessionContext>{
 const userId=await createAppUser(b.tenantId,personIds[n-1],role);
 return {...await entitledCtx(b,[role]),userId,personId:personIds[n-1],roles:[role],grants:[{role,companyId:null}]};
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
  // The unrelated company where the manager's cross-company report works: outside the subtree, so nothing.
  expect(await teamAttendanceToday(manager,{date:today,scopeIds:[companyOf(17)]})).toEqual(expected([]));
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
