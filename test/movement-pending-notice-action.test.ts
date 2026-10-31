import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as movement from '../core/movement';
import {hireEmployee} from '../core/org';
import {domainEvent} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ADMIN:ReturnType<typeof adminCtx>,redirected='';
vi.mock('../lib/authz',()=>({requireAdmin:async()=>ADMIN}));
vi.mock('next/cache',()=>({revalidatePath:()=>{}}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{redirected=url;throw Error('NEXT_REDIRECT');}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
import {createMovementEventAction,editMovementEventAction} from '../app/(app)/admin/personnel/[employmentId]/actions';
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.restoreAllMocks();await resetDb();b=await seedBase();ADMIN=adminCtx(b);redirected='';});
async function subject(){return (await hireEmployee(ADMIN,{person:{fullName:'Fictional notice correction',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60),employeeCode:'B22-NOTICE'})).employmentId;}
function form(id:string){const data=new FormData();for(const [key,value]of Object.entries({employmentId:id,kind:'termination',effectiveDate:day(31),endDate:day(29),terminationReasonCode:'resignation',resignationDate:day(20),remarks:'Fictional notice correction',reason:'Fictional explicit correction'}))data.set(key,value);return data;}
async function pending(id:string){return (await movement.movementHistory(ADMIN,id)).find(r=>r.status==='pending')!;}

describe('pending termination notice presence through the actual Personnel server action',()=>{
 it.each([['',null],['0',0]] as const)('preserves an explicitly submitted notice value %j rather than restoring the saved14',async(raw,expected)=>{
  const id=await subject();await movement.createMovementEvent(ADMIN,{employmentId:id,kind:'termination',effectiveDate:day(30),endDate:day(29),terminationReasonCode:'resignation',resignationDate:day(20),terminationNoticeDays:14});
  const original=await pending(id),data=form(id);data.set('movementId',original.id);data.set('terminationNoticeDays',raw);
  await expect(editMovementEventAction(data)).rejects.toThrow('NEXT_REDIRECT');expect(redirected).toContain('toast=Saved');
  const revised=await pending(id),[event]=await owner.db.select({payload:domainEvent.payload}).from(domainEvent).where(eq(domainEvent.id,revised.id));
  expect((event.payload as {input:{terminationNoticeDays:number|null}}).input.terminationNoticeDays).toBe(expected);
 });
 it('retains the saved notice when the action receives no notice field at all',async()=>{
  const id=await subject();await movement.createMovementEvent(ADMIN,{employmentId:id,kind:'termination',effectiveDate:day(30),endDate:day(29),terminationReasonCode:'resignation',resignationDate:day(20),terminationNoticeDays:14});
  const original=await pending(id),data=form(id);data.set('movementId',original.id);
  expect(data.has('terminationNoticeDays')).toBe(false);await expect(editMovementEventAction(data)).rejects.toThrow('NEXT_REDIRECT');expect(redirected).toContain('toast=Saved');
  expect((await movement.movementPendingEditInput(ADMIN,id,(await pending(id)).id))?.values?.terminationNoticeDays).toBe('14');
 });
 it('keeps New Event blank-notice parsing unchanged',async()=>{
  const id=await subject(),spy=vi.spyOn(movement,'createMovementEvent'),data=form(id);data.set('terminationNoticeDays','');
  await expect(createMovementEventAction(data)).rejects.toThrow('NEXT_REDIRECT');expect(redirected).toContain('toast=Saved');
  expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][1].terminationNoticeDays).toBeUndefined();
 });
});
