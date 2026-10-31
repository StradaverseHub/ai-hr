import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {appUser,person} from '../db/schema';
import {getEmployeeHomePreferences,getDashboardLayout,setDashboardLayout} from '../core/dashboard-prefs';
import {listEmployeeHomeCards,listCards,setStatus,seedEmployeeHomeCardCatalog} from '../core/dashboard-card-config';
import {defaultEmployeeHomePreferences,EMPLOYEE_HOME_CARDS} from '../lib/employee-home';
import {BUILTIN_ROLE_DASHBOARD_CARDS} from '../lib/dashboard-layout';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,CALLER:SessionContext;
const locale=vi.hoisted(()=>vi.fn());
vi.mock('../lib/session',()=>({getSession:async()=>CALLER}));
vi.mock('../app/i18n-actions',()=>({setLocale:locale}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('confirmed-redirect:'+path);},unstable_rethrow:()=>{}}));
const {saveHomePreferencesAction}=await import('../app/(app)/me/home/actions');
async function login(){
 const [p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional Home preference owner',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return {tenantId:b.tenantId,userId,personId:p.id,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
}
function form(){
 const f=new FormData();f.set('command','save');f.set('locale','ms');f.set('timeZone','Asia/Tokyo');f.set('weekStartsOn','0');
 for(const key of [...EMPLOYEE_HOME_CARDS].reverse())f.append('cardOrder',key);
 f.append('hiddenCard','team');return f;
}
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{vi.clearAllMocks();await resetDb();b=await seedBase();CALLER=await login();await owner.db.transaction(tx=>seedEmployeeHomeCardCatalog(tx,b.tenantId));});
describe('Home preference form writes through the current own-account owner',()=>{
 it('saves and reopens the rendered choices without changing another login or another role',async()=>{
  const other=await login();
  await setDashboardLayout(CALLER,{selected:['teamAwayToday'],order:['teamAwayToday']},BUILTIN_ROLE_DASHBOARD_CARDS.manager,'manager');
  await expect(saveHomePreferencesAction({error:null},form())).rejects.toThrow('confirmed-redirect:/me/home?saved=1');
  const cards=await listEmployeeHomeCards(CALLER);
  expect(await getEmployeeHomePreferences(CALLER,cards)).toEqual({...defaultEmployeeHomePreferences(),timeZone:'Asia/Tokyo',weekStartsOn:0,cardOrder:[...EMPLOYEE_HOME_CARDS].reverse(),hiddenCards:['team']});
  expect(await getEmployeeHomePreferences(other,cards)).toEqual(defaultEmployeeHomePreferences());
  expect((await getDashboardLayout(CALLER,BUILTIN_ROLE_DASHBOARD_CARDS.manager,'manager')).selected).toEqual(['teamAwayToday']);
  expect((locale.mock.calls[0][0] as FormData).get('locale')).toBe('ms');
  const reset=new FormData();reset.set('command','reset');await expect(saveHomePreferencesAction({error:null},reset)).rejects.toThrow('confirmed-redirect:/me/home?saved=1');
  expect(await getEmployeeHomePreferences(CALLER,cards)).toEqual(defaultEmployeeHomePreferences());
  expect((await getDashboardLayout(CALLER,BUILTIN_ROLE_DASHBOARD_CARDS.manager,'manager')).selected).toEqual(['teamAwayToday']);
  expect(locale).toHaveBeenCalledOnce();
 });
 it('refuses posted identity, duplicate fields, incomplete order, invalid language/timezone and mandatory hiding',async()=>{
  const attempts=[form(),form(),form(),form(),form(),form()];
  attempts[0].set('userId',randomUUID());attempts[1].append('weekStartsOn','1');attempts[2].delete('cardOrder');
  attempts[3].set('locale','invented');attempts[4].set('timeZone','invalid/timezone');attempts[5].append('hiddenCard','summary');
  for(const data of attempts)expect(await saveHomePreferencesAction({error:null},data)).toEqual({error:'invalid'});
  const [row]=await owner.db.select().from(appUser).where(eq(appUser.id,CALLER.userId!));expect(row.dashboardLayout).toBeNull();expect(locale).not.toHaveBeenCalled();
 });
 it('reads HR card availability again after a form was rendered',async()=>{
  const rendered=form(),notices=(await listCards(adminCtx(b))).find(row=>row.cardKey==='notices')!;
  await setStatus(adminCtx(b),{id:notices.id,status:'inactive'});
  await expect(saveHomePreferencesAction({error:null},rendered)).rejects.toThrow('confirmed-redirect:/me/home?saved=1');
  expect((await getEmployeeHomePreferences(CALLER,await listEmployeeHomeCards(CALLER))).hiddenCards).toContain('notices');
 });
 it('refuses an archived principal even when an earlier session still names Employee',async()=>{
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,CALLER.userId!));
  expect(await saveHomePreferencesAction({error:null},form())).toEqual({error:'forbidden'});
  const reset=new FormData();reset.set('command','reset');expect(await saveHomePreferencesAction({error:null},reset)).toEqual({error:'forbidden'});
  const [row]=await owner.db.select().from(appUser).where(eq(appUser.id,CALLER.userId!));expect(row.dashboardLayout).toBeNull();expect(locale).not.toHaveBeenCalled();
 });
});
