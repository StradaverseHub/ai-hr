import {beforeAll,beforeEach,afterAll,afterEach,vi,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,resignationCase,resignationInbox} from '../packs/lifecycle/resignation/service';
import {myResignation,listResignationRequests,decideResignation} from '../core/offboarding';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

describe('managed resignation service composes one workflow authority',()=>{
 it('assigns decision and FYI separately, preserves the request UUID and excludes managed cases from legacy inboxes',async()=>{
  const f=await resignationJourneyFixture();
  const action=await resignationInbox(f.admin,{kind:'approvals'}),fyi=await resignationInbox(f.watcher,{kind:'approvals'});
  expect(action).toMatchObject({total:1,actionableTotal:1,fyiTotal:0});expect(action.items[0]).toMatchObject({caseId:f.journey.id,kind:'decision',actionable:true});expect(action.cases.map(c=>c.id)).toEqual([f.journey.id]);
  expect(fyi).toMatchObject({total:1,actionableTotal:0,fyiTotal:1});expect(fyi.items[0]).toMatchObject({kind:'fyi',canComment:true,actionable:false});
  expect(await myResignation(f.staff,f.employee.employmentId)).toBeNull();expect(await listResignationRequests(f.admin)).toEqual([]);
  const commented=await commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'comment',text:'Please confirm the handover.'}});expect(commented.comments.at(-1)?.text).toBe('Please confirm the handover.');
  await expect(commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:commented.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}})).rejects.toMatchObject({code:'forbidden'});
  await expect(commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}})).rejects.toMatchObject({code:'conflict'});
 },90000);
 it('acceptance keeps employment active and leave unfrozen until clearance; replacement creates one actionable HR request',async()=>{
  const f=await resignationJourneyFixture();const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:true}});
  expect(accepted.replacementRequest).toMatchObject({status:'requested',reference:null});
  const [row]=await owner.db.execute<{termination:string|null;status:string}>(sql`select e.termination_date::text as termination,r.status from employment e join resignation_request r on r.employment_id=e.id where e.id=${f.employee.employmentId}::uuid and r.id=${f.journey.id}::uuid`);expect(row).toEqual({termination:null,status:'pending'});
  await expect(decideResignation(f.admin,{requestId:f.journey.id,decision:'accepted'})).rejects.toThrow(/clearance/);
  const tasks=await resignationInbox(f.admin,{kind:'tasks'});expect(tasks.items.filter(t=>t.kind==='recruitment')).toHaveLength(1);
  const complete=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:accepted.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/requests/approved'}});expect(complete.replacementRequest?.status).toBe('completed');
  await expect(commandResignationJourney(f.admin,{caseId:f.journey.id,revision:complete.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/requests/duplicate'}})).rejects.toMatchObject({code:'forbidden'});
 },90000);
 it('an own withdrawal closes only this managed case and preserves history; cross-case readers remain denied',async()=>{
  const f=await resignationJourneyFixture(),other=await resignationJourneyFixture();await expect(resignationCase(other.staff,f.journey.id)).rejects.toMatchObject({code:'forbidden'});
  const withdrawn=await commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'}});expect(withdrawn.stage).toBe('withdrawn');expect((await resignationInbox(f.admin,{kind:'approvals'})).total).toBe(0);
  const [request]=await owner.db.execute<{status:string}>(sql`select status from resignation_request where id=${f.journey.id}::uuid`);expect(request.status).toBe('withdrawn');expect((await resignationCase(f.staff,f.journey.id)).id).toBe(f.journey.id);
 },90000);
});
