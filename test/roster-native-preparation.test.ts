import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createRequire} from 'node:module';
// The installed test runtime has no declaration; assert only the constructor surface used here.
const JSDOM=createRequire(import.meta.url)('jsdom').JSDOM as new(html:string)=>{window:{document:Document}};
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createTranslator} from 'next-intl';
import type {SessionContext} from '../db/client';
import * as database from '../db/client';
import * as accessOwner from '../core/access-configuration-lock';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {ensureStandardRule} from '../core/attendance-rule';
import {hireEmployee} from '../core/org';
import {assignShift,createShift,generateRosterFromTemplate,rosterForRange,type ReviewedRosterDepartment} from '../core/roster';
import {rosterDepartmentIds} from '../core/roster-presentation';
import {listEmployeesPage} from '../core/read';
import {serializeMyTeamQuery} from '../lib/my-team-query';
import {todayInKualaLumpur} from '../lib/hr-date';
import messages from '../messages/en.json';
let session:SessionContext,scopeIds:string[],b:Base,shiftId:string,ids:string[];
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:session,scopeIds}),getScopeIds:async()=>scopeIds}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async(namespace:'roster'|'pagination')=>createTranslator({locale:'en',messages:messages[namespace]})}));
vi.mock('../lib/ui-theme-server',()=>({currentUiTheme:async()=> 'classic'}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
import {POST} from '../app/roster/prepare/route';
beforeAll(migrateTestDb);afterAll(closeAll);
async function hire(name:string,companyId=b.companyId,departmentId=b.deptA){return (await hireEmployee(session,{person:{fullName:name,primaryEmail:randomUUID()+'@native-roster.invalid'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'})).employmentId;}
beforeEach(async()=>{
 await resetDb();b=await seedBase();session={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};scopeIds=[b.companyId];
 ids=[await hire('<img src=x onerror=alert(1)>'),await hire('Native second'),await hire('Native third')];
 shiftId=(await createShift(session,{name:'Native <shift> & review',code:'NATIVE',startTime:'09:00',endTime:'18:00',weeklyPattern:[1,2,3,4,5]})).id;
 for(const employmentId of ids)await assignShift(session,{employmentId,shiftDate:'2027-01-04',shiftId});
});
function packet(command='copy'){
 return new URLSearchParams({command,stage:'prepare',companyId:b.companyId,populationQuery:new URLSearchParams({companyId:b.companyId,view:'month',month:'2027-01'}).toString(),selectionMode:'matching',shiftId,departmentId:'',from:'2027-01-11',to:'2027-01-12',sourceFrom:'2027-01-04',sourceTo:'2027-01-04',targetFrom:'2027-01-11'});
}
function post(body:URLSearchParams,headers:Record<string,string>={}){
 return POST(new Request('https://roster.example.invalid/roster/prepare',{method:'POST',headers:{origin:'https://roster.example.invalid','content-type':'application/x-www-form-urlencoded',...headers},body}));
}
function formPacket(document:Document){
 const form=document.querySelector('form')!;expect(form).not.toBeNull();const result=new URLSearchParams();
 for(const input of form.querySelectorAll<HTMLInputElement>('input[name]'))if(input.type!=='checkbox'||input.checked)result.append(input.name,input.value);
 return result;
}
async function document(response:Response){return new JSDOM(await response.text()).window.document;}
async function events(){return Number((await owner.db.select({n:sql<number>`count(*)::int`}).from(schema.domainEvent))[0].n);}

it('uses a native no-JS prepare/count/review/confirm journey and excludes a subsequent new hire',async()=>{
 const before=await events(),prepared=await post(packet());expect(prepared.status).toBe(200);expect(prepared.headers.get('Cache-Control')).toBe('private, no-store');expect(await events()).toBe(before);
 const dom=await document(prepared);expect(dom.querySelector('script')).toBeNull();expect(dom.querySelector('img')).toBeNull();expect(dom.body.textContent).toContain('<img src=x onerror=alert(1)>');expect(dom.body.textContent).toContain('3 selected');expect(dom.querySelectorAll('tbody tr')).toHaveLength(3);
 const confirmation=formPacket(dom);expect(confirmation.get('stage')).toBe('confirm');expect(JSON.parse(confirmation.get('selectionIds')!)).toEqual(expect.arrayContaining(ids));expect(dom.querySelector('form')!.getAttribute('action')).toBe('/roster/prepare');
 const arrival=await hire('Native later arrival');await assignShift(session,{employmentId:arrival,shiftDate:'2027-01-04',shiftId});
 const confirmed=await post(confirmation);expect(confirmed.status).toBe(303);expect(confirmed.headers.get('Location')).toContain('copied=3');
 const written=await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'});expect(written.map(row=>row.employmentId).sort()).toEqual([...ids].sort());expect(written.some(row=>row.employmentId===arrival)).toBe(false);
});

it('retains individual selection through native POST pages without putting IDs in URLs',async()=>{
 for(let n=0;n<25;n++){const employmentId=await hire('Native extra '+String(n).padStart(2,'0'));await assignShift(session,{employmentId,shiftDate:'2027-01-04',shiftId});}
 const initial=packet('generate');initial.set('stage','browse');initial.delete('selectionMode');
 const first=await document(await post(initial));expect(first.querySelectorAll('input[type="checkbox"]')).toHaveLength(25);
 const chosen=first.querySelector<HTMLInputElement>('input[type="checkbox"]')!;chosen.checked=true;const selectedId=chosen.value;
 const next=formPacket(first);next.set('offset','25');const last=await document(await post(next));expect(last.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);expect(last.body.textContent).toContain('1 selected');
 expect(JSON.parse((last.querySelector('input[name="selectionIds"]') as HTMLInputElement).value)).toContain(selectedId);
 const second=last.querySelector<HTMLInputElement>('input[type="checkbox"]')!;second.checked=true;
 const review=formPacket(last);review.set('review','selected');const reviewed=await document(await post(review));expect(reviewed.body.textContent).toContain('2 selected');
 const confirmed=await post(formPacket(reviewed));expect(confirmed.status).toBe(303);
 const written=await rosterForRange(session,{from:'2027-01-11',to:'2027-01-12'});expect([...new Set(written.map(row=>row.employmentId))].sort()).toEqual([selectedId,second.value].sort());
 expect([...first.querySelectorAll('a,form')].every(el=>!(el.getAttribute('href')??el.getAttribute('action')??'').includes(selectedId))).toBe(true);
 const all=packet();all.set('targetFrom','2027-01-18');const allReview=await document(await post(all));
 expect(allReview.querySelectorAll('tbody tr')).toHaveLength(25);const allConfirmation=formPacket(allReview);expect(JSON.parse(allConfirmation.get('selectionIds')!)).toHaveLength(28);
 expect((await post(allConfirmation)).status).toBe(303);expect(await rosterForRange(session,{from:'2027-01-18',to:'2027-01-18'})).toHaveLength(28);
},60000);

it.each([undefined,'[]','["bad-id"]'])('refuses absent/empty/forged confirm sets and raw legacy bypasses',async selection=>{
 const data=packet();data.set('stage','confirm');data.append('employmentIds',ids[0]);if(selection!==undefined)data.set('selectionIds',selection);
 const before=await events(),result=await post(data);expect(result.status).toBe(400);expect(await events()).toBe(before);expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'})).toEqual([]);
});

it('refuses a foreign ID and a missing company even when native RLS would expose other current companies',async()=>{
 const other=(await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other native company'}).returning())[0];
 const otherDepartment=(await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:other.id,name:'Other native department'}).returning())[0];
 const outside=await hire('Other company employee',other.id,otherDepartment.id);scopeIds.push(other.id);
 const data=packet();data.set('stage','confirm');data.set('selectionIds',JSON.stringify([outside]));expect((await post(data)).status).toBe(400);
 data.set('companyId','');expect((await post(data)).status).toBe(400);expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'})).toEqual([]);
});

it('uses the real fresh team scope for preparation and refuses extra posted members',async()=>{
 const data=packet();data.set('populationQuery',new URLSearchParams({companyId:b.companyId,myTeam:serializeMyTeamQuery({view:'week',scope:'department',anchorDate:todayInKualaLumpur(),companyIds:[b.companyId],employmentId:ids[0],layers:{roster:true,attendance:false,leave:false}}).toString()}).toString());
 const prepared=await post(data);expect(prepared.status).toBe(200);const confirmation=formPacket(await document(prepared));expect(JSON.parse(confirmation.get('selectionIds')!)).toEqual([ids[0]]);
 confirmation.set('selectionIds',JSON.stringify([ids[0],ids[1]]));expect((await post(confirmation)).status).toBe(400);expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'})).toEqual([]);
},60000);

it('preserves the exact old department population and canonical generation while narrowing posted company scope',async()=>{
 await owner.db.update(schema.employment).set({terminatedOn:'2099-01-01'}).where(eq(schema.employment.id,ids[2]));
 await owner.db.update(schema.assignment).set({validTo:'2099-01-01'}).where(eq(schema.assignment.employmentId,ids[1]));
 const canonical=await listEmployeesPage(session,{departmentId:b.deptA,status:'active',limit:100000,offset:0});
 expect(canonical.rows.map(row=>row.employmentId).sort()).toEqual(ids.slice(0,2).sort());
 expect((await rosterDepartmentIds(session,{departmentId:b.deptA,shiftId})).sort()).toEqual(canonical.rows.map(row=>row.employmentId).sort());
 const baseline=await generateRosterFromTemplate(session,{departmentId:b.deptA,shiftId,from:'2027-01-18',to:'2027-01-19'});expect(baseline.employments).toBe(2);
 const data=packet('generate');data.set('departmentId',b.deptA);const reviewed=await document(await post(data));const confirmation=formPacket(reviewed);expect(JSON.parse(confirmation.get('selectionIds')!).sort()).toEqual(ids.slice(0,2).sort());
 expect((await post(confirmation)).status).toBe(303);const written=await rosterForRange(session,{from:'2027-01-11',to:'2027-01-12'});expect(written).toHaveLength(baseline.workingRows+baseline.restRows);expect([...new Set(written.map(row=>row.employmentId))].sort()).toEqual(ids.slice(0,2).sort());
 const c=(await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Chosen empty company'}).returning())[0];scopeIds.push(c.id);data.set('companyId',c.id);data.set('populationQuery',new URLSearchParams({companyId:c.id}).toString());expect((await post(data)).status).toBe(400);
},60000);

it('refuses cross-origin, malformed, duplicate fields and actual oversized streams before a command',async()=>{
 expect((await post(packet(),{origin:'https://elsewhere.invalid'})).status).toBe(403);
 const duplicate=packet();duplicate.append('command','copy');expect((await post(duplicate)).status).toBe(400);
 const malformed=packet();malformed.set('selectionIds','[');expect((await post(malformed)).status).toBe(400);
 const chunk=new TextEncoder().encode('x'.repeat(6_000_001));const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(chunk);controller.close();}});
 const oversized=new Request('https://roster.example.invalid/roster/prepare',{method:'POST',headers:{origin:'https://roster.example.invalid','content-type':'application/x-www-form-urlencoded'},body,duplex:'half'} as RequestInit&{duplex:'half'});
 expect((await POST(oversized)).status).toBe(413);expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'})).toEqual([]);
});

it.each([
 ['generate',{from:'2027-01-12',to:'2027-01-11'},'The end date must not be before the start date'],
 ['generate',{from:'2027-01-01',to:'2028-01-03'},'Generate at most one year at a time'],
 ['copy',{sourceFrom:'2027-01-05',sourceTo:'2027-01-04'},'The source end date must not be before the source start date'],
 ['copy',{sourceFrom:'2027-01-01',sourceTo:'2028-01-03'},'Copy at most one year of source roster at a time'],
 ['copy',{targetFrom:'2027-01-04'},'The target start date must differ from the source start date'],
] as const)('refuses browser-valid %s ranges before review and preserves editable submitted controls',async(command,values,message)=>{
 const data=packet(command);data.set('selectionMode','selected');data.set('selectionIds',JSON.stringify([ids[0]]));data.set('currentPageIds',JSON.stringify([ids[1]]));data.append('employmentIds',ids[1]);for(const [key,value] of Object.entries(values))data.set(key,value);
 const before=await events(),response=await post(data);expect(response.status).toBe(422);
 const page=await document(response);expect(page.querySelector('[role="alert"]')?.textContent).toBe(message);
 const retry=formPacket(page);for(const [key,value] of Object.entries(values))expect(retry.get(key)).toBe(value);
 expect(JSON.parse(retry.get('selectionIds')!)).toEqual([ids[0],ids[1]]);expect(retry.get('companyId')).toBe(b.companyId);expect(retry.get('shiftId')).toBe(shiftId);expect(retry.get('stage')).toBe('prepare');
 expect(page.querySelector('a')?.getAttribute('href')).toContain('/roster?');expect(await events()).toBe(before);
});

it.each(['archived','no-working-days'] as const)('returns a readable refusal when the reviewed template becomes %s, preserving the exact set',async change=>{
 const review=await document(await post(packet('generate'))),confirmation=formPacket(review),before=await events();
 await owner.db.update(schema.shift).set(change==='archived'?{archivedAt:new Date()}:{weeklyPattern:[],halfPattern:[],offPattern:[]}).where(eq(schema.shift.id,shiftId));
 const result=await post(confirmation);expect(result.status).toBe(422);const page=await document(result);
 expect(page.querySelector('[role="alert"]')?.textContent).toContain(change==='archived'?'Cannot generate a roster from an archived shift':'This shift has no working days');
 const retry=formPacket(page);expect(retry.get('selectionIds')).toBe(confirmation.get('selectionIds'));expect(retry.get('from')).toBe('2027-01-11');expect(retry.get('shiftId')).toBe(shiftId);
 expect(await events()).toBe(before);expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-12'})).toEqual([]);
});

/** The Access lock attempt is the barrier: read admission finished, canonical write has queued. */
it.each(['transfer','new-arrival'] as const)('rechecks reviewed department targets after the original write locks: %s',async change=>{
 const data=packet('generate');data.set('departmentId',b.deptA);
 const confirmation=formPacket(await document(await post(data))),reviewed=JSON.parse(confirmation.get('selectionIds')!) as string[],before=await events();
 let entered!:()=>void,release!:()=>void,queued!:()=>void;
 const held=new Promise<void>(resolve=>{entered=resolve;}),unblock=new Promise<void>(resolve=>{release=resolve;}),attempted=new Promise<void>(resolve=>{queued=resolve;});
 const newcomer=randomUUID(),newPerson=randomUUID();
 const writer=database.withTenant(session,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);entered();await unblock;
  if(change==='transfer')await tx.update(schema.assignment).set({departmentId:b.deptB}).where(eq(schema.assignment.employmentId,ids[0]));
  else{
   await tx.insert(schema.person).values({id:newPerson,tenantId:b.tenantId,fullName:'Unreviewed queued arrival'});
   await tx.insert(schema.employment).values({id:newcomer,tenantId:b.tenantId,personId:newPerson,companyId:b.companyId,hiredOn:'2020-01-01'});
   await tx.insert(schema.assignment).values({tenantId:b.tenantId,employmentId:newcomer,departmentId:b.deptA,employmentType:'full_time',validFrom:'2020-01-01'});
  }
 });
 let pending:Promise<Response>|undefined;
 const original=accessOwner.lockAccessConfigurationTx;
 const spy=vi.spyOn(accessOwner,'lockAccessConfigurationTx').mockImplementation(async(tx,tenantId)=>{queued();return original(tx,tenantId);});
 try{
  await held;pending=post(confirmation);
  await deadline(attempted,5000);release();await writer;
  const response=await deadline(pending,10000);
  if(change==='transfer'){
   expect(response.status).toBe(422);const page=await document(response);expect(page.querySelector('[role="alert"]')?.textContent).toContain('department selection changed');
   expect(JSON.parse(formPacket(page).get('selectionIds')!)).toEqual(reviewed);expect(await events()).toBe(before);
   expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-12'})).toEqual([]);
  }else{
   expect(response.status).toBe(303);const rows=await rosterForRange(session,{from:'2027-01-11',to:'2027-01-12'});
   expect([...new Set(rows.map(row=>row.employmentId))].sort()).toEqual(reviewed.slice().sort());expect(rows.some(row=>row.employmentId===newcomer)).toBe(false);
  }
 }finally{release();await writer;await Promise.allSettled(pending?[pending]:[]);spy.mockRestore();}
},30000);
function deadline<T>(promise:Promise<T>,ms:number):Promise<T>{let timer:ReturnType<typeof setTimeout>;return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native journey barrier deadline exceeded')),ms);})]).finally(()=>clearTimeout(timer));}

it('does not render a driver/storage failure as a user validation refusal',async()=>{
 const failure=new Error('private SQL failure details');const spy=vi.spyOn(database,'withTenant').mockRejectedValueOnce(failure);
 try{await expect(post(packet())).rejects.toBe(failure);}finally{spy.mockRestore();}
});

it('validates the public reviewed department seam independently and keeps legacy both-field precedence',async()=>{
 const base:ReviewedRosterDepartment={departmentId:b.deptA,employmentIds:[ids[0]],companyIds:[b.companyId]};
 const command=(reviewedDepartment:ReviewedRosterDepartment,context=session)=>generateRosterFromTemplate(context,{shiftId,reviewedDepartment,from:'2027-01-11',to:'2027-01-11'});
 for(const invalid of [
  {...base,employmentIds:[]}, {...base,employmentIds:[ids[0],ids[0]]}, {...base,employmentIds:['malformed']},
  {...base,companyIds:[]},{...base,companyIds:[b.companyId,b.companyId]}, {...base,departmentId:'malformed'},
  {...base,employmentIds:Array.from({length:100001},()=>ids[0])},
  {...base,teamQuery:'x'.repeat(4_000_003)}, {...base,teamQuery:'view=week&scope=department&tile=members'},
 ] as ReviewedRosterDepartment[])await expect(command(invalid)).rejects.toThrow();
 await expect(command({...base,companyIds:[randomUUID()]})).rejects.toThrow('company scope');
 await expect(command({...base,employmentIds:[randomUUID()]})).rejects.toThrow('department selection changed');
 await expect(command(base,{...session,userId:randomUUID()})).rejects.toThrow('calling authority');
 const teamQuery=serializeMyTeamQuery({view:'week',scope:'department',companyIds:[b.companyId],search:'Native second'}).toString();
 await expect(command({...base,teamQuery})).rejects.toThrow('current team scope');
 expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'})).toEqual([]);
 const both=await generateRosterFromTemplate(session,{shiftId,departmentId:b.deptA,employmentIds:[ids[0]],from:'2027-01-11',to:'2027-01-11'});
 expect(both.employments).toBe(3);
 const narrowed=await command(base);expect(narrowed.employments).toBe(1);
},60000);

it('reports an archived source shift through the canonical Copy refusal without partial writes',async()=>{
 const confirmation=formPacket(await document(await post(packet()))),before=await events();
 await owner.db.update(schema.shift).set({archivedAt:new Date()}).where(eq(schema.shift.id,shiftId));
 const response=await post(confirmation);expect(response.status).toBe(422);const page=await document(response);
 expect(page.querySelector('[role="alert"]')?.textContent).toBe('An archived shift cannot be selected for a new assignment. Select an active shift.');
 expect(formPacket(page).get('selectionIds')).toBe(confirmation.get('selectionIds'));expect(await events()).toBe(before);
 expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-11'})).toEqual([]);
});

it.each(['duty-off','shift-not-allowed'] as const)('renders canonical %s changes after review and rolls back the entire command',async change=>{
 const confirmation=formPacket(await document(await post(packet('generate'))));
 const group=await ensureStandardRule(session);
 await owner.db.update(schema.attendanceRule).set({dutyRosterControl:change!=='duty-off'}).where(eq(schema.attendanceRule.id,group.id));
 await owner.db.update(schema.employment).set({attendanceRuleId:group.id}).where(eq(schema.employment.id,ids[1]));
 const before=await events(),response=await post(confirmation);expect(response.status).toBe(422);const page=await document(response);
 expect(page.querySelector('[role="alert"]')?.textContent).toContain(change==='duty-off'?'Duty Roster Control is Off':'does not allow any shift');
 expect(formPacket(page).get('selectionIds')).toBe(confirmation.get('selectionIds'));expect(await events()).toBe(before);
 expect(await rosterForRange(session,{from:'2027-01-11',to:'2027-01-12'})).toEqual([]);
});
