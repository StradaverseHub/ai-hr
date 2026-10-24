import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {dashboardCardConfig,person} from '../db/schema';
import {listEmployeeHomeCards,seedEmployeeHomeCardCatalog,listCards,updateCard,setStatus,deleteCard} from '../core/dashboard-card-config';
import {getEmployeeHomePreferences,setEmployeeHomePreferences} from '../core/dashboard-prefs';
import {EMPLOYEE_HOME_CARDS,EMPLOYEE_HOME_CARD_DEFAULTS,defaultEmployeeHomePreferences} from '../lib/employee-home';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function seed(){await owner.db.transaction(tx=>seedEmployeeHomeCardCatalog(tx,b.tenantId));}
describe('Home slots reuse the canonical editable Dashboard Card Master',()=>{
 it('offers the exact eight defaults for a new tenant and saves them idempotently',async()=>{
  const a=adminCtx(b);
  expect(await listEmployeeHomeCards(a)).toEqual(EMPLOYEE_HOME_CARD_DEFAULTS);
  await seed();await seed();
  const stored=await listCards(a);expect(stored).toHaveLength(8);
  expect(stored.map(row=>row.cardKey)).toEqual([...EMPLOYEE_HOME_CARDS]);
  expect(await listEmployeeHomeCards(a)).toEqual(EMPLOYEE_HOME_CARD_DEFAULTS);
  expect(await getEmployeeHomePreferences(a,await listEmployeeHomeCards(a))).toEqual(defaultEmployeeHomePreferences());
 });
 it('never revives a saved inactive card or a card outside the employee audience',async()=>{
  await seed();const a=adminCtx(b),rows=await listCards(a);
  await setStatus(a,{id:rows.find(row=>row.cardKey==='timeOff')!.id,status:'inactive'});
  await updateCard(a,{id:rows.find(row=>row.cardKey==='team')!.id,audience:['hr_admin']});
  const cards=await listEmployeeHomeCards(a);expect(cards.map(row=>row.cardKey)).not.toContain('timeOff');expect(cards.map(row=>row.cardKey)).not.toContain('team');
  const preferences=await getEmployeeHomePreferences(a,cards);expect(preferences.hiddenCards).toEqual(['timeOff','team']);
  await owner.db.transaction(tx=>seedEmployeeHomeCardCatalog(tx,b.tenantId));
  expect((await listCards(a)).find(row=>row.cardKey==='timeOff')?.status).toBe('inactive');
 });
 it('retains stable slot identities and the mandatory summary while allowing optional status changes',async()=>{
  await seed();const a=adminCtx(b),rows=await listCards(a),summary=rows.find(row=>row.cardKey==='summary')!,optional=rows.find(row=>row.cardKey==='timeOff')!;
  for(const change of [{mandatory:false},{status:'inactive'},{employeeSelectable:true},{audience:['manager']}])await expect(updateCard(a,{id:summary.id,...change})).rejects.toThrow(/required/);
  await expect(setStatus(a,{id:summary.id,status:'inactive'})).rejects.toThrow(/required/);
  await expect(deleteCard(a,{id:summary.id})).rejects.toThrow(/retained/);
  await expect(updateCard(a,{id:optional.id,cardKey:'renamedTimeOff'})).rejects.toThrow(/cannot be renamed/);
  await expect(deleteCard(a,{id:optional.id})).rejects.toThrow(/Deactivate/);
  await setStatus(a,{id:optional.id,status:'inactive'});
  expect((await listEmployeeHomeCards(a)).map(row=>row.cardKey)).toContain('summary');
 });
 it('saves actual catalog-backed own preferences and respects a fresh master change',async()=>{
  await seed();const a=adminCtx(b);
  const [loginPerson]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional preference owner',primaryEmail:'fictional-home-prefs@example.invalid'}).returning();
  const userId=await createAppUser(b.tenantId,loginPerson.id,'employee');
  const ctx:SessionContext={tenantId:b.tenantId,userId,personId:loginPerson.id,roles:['employee']};
  const cards=await listEmployeeHomeCards(ctx),prefs={...defaultEmployeeHomePreferences(),hiddenCards:['team' as const],cardOrder:[...EMPLOYEE_HOME_CARDS].reverse(),weekStartsOn:0,timeZone:'Asia/Tokyo'};
  await setEmployeeHomePreferences(ctx,prefs,cards);expect(await getEmployeeHomePreferences(ctx,cards)).toEqual(prefs);
  const timeOff=(await listCards(a)).find(row=>row.cardKey==='timeOff')!;
  await setStatus(a,{id:timeOff.id,status:'inactive'});
  const refreshed=await getEmployeeHomePreferences(ctx,await listEmployeeHomeCards(ctx));expect(refreshed.hiddenCards).toContain('timeOff');expect(refreshed.hiddenCards).toContain('team');
  await expect(setStatus(ctx,{id:timeOff.id,status:'active'})).rejects.toThrow();
  expect((await owner.db.select().from(dashboardCardConfig).where(eq(dashboardCardConfig.id,timeOff.id)))[0].status).toBe('inactive');
 });
});
