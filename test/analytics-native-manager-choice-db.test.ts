import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {createTranslator} from 'next-intl';
import {eq,sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {appUser,company,domainEvent} from '../db/schema';
import {closeAll,migrateTestDb,owner} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import messages from '../messages/en.json';
let session:SessionContext,scopeIds:string[];
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:session,scopeIds})}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async(namespace:'employeePanel'|'analytics')=>createTranslator({locale:'en',messages:messages[namespace]})}));
vi.mock('../lib/ui-theme-server',()=>({currentUiTheme:async()=> 'classic'}));
import {POST} from '../app/analytics/manager-choices/route';
beforeAll(migrateTestDb);afterAll(closeAll);
function post(body:URLSearchParams){return POST(new Request('https://hr.example/analytics/manager-choices',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/x-www-form-urlencoded'},body}));}
async function doc(response:Response){expect(response.status).toBe(200);return new JSDOM(await response.text()).window.document;}
function formPacket(document:Document){const form=document.querySelector('form')!;expect(form.method).toBe('post');expect(form.getAttribute('action')).toBe('/analytics/manager-choices');const data=new URLSearchParams();for(const field of form.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[name],select[name]'))data.append(field.name,field.value);return data;}
it('uses actual native-RLS 50k choices for no-JS first/deep/search/apply and refuses foreign, narrowed and revoked access without effects',async()=>{
 const fixture=await seedPersonnelNativeFixture(50000,{},()=>{},()=>{});session=fixture.ctx;scopeIds=[fixture.b.companyId];
 const selectedId=fixture.expectedLast.at(-1)!;
 const initial=new URLSearchParams({managerEmploymentId:selectedId,from:'2020-01-01',to:'2026-11-07',departmentId:fixture.b.deptA,choiceContext:JSON.stringify({year:'2025',hirePage:'1999',hireSize:'25',carryPage:'10',carrySize:'50',q:'existing-report-term'})});
 const [before]=await owner.db.select({n:sql<number>`count(*)::int`}).from(domainEvent);
 const first=await doc(await post(initial));expect(first.querySelector('script')).toBeNull();expect(first.querySelectorAll('option')).toHaveLength(27);expect(first.body.textContent).toContain('1–25 of 50,000');expect(first.querySelector<HTMLSelectElement>('select')!.value).toBe(selectedId);
 expect([...first.querySelectorAll('option')].slice(2).map(row=>row.value)).toEqual(fixture.expectedFirst);
 const next=formPacket(first);next.set('offset','49975');const deep=await doc(await post(next));
 expect(deep.body.textContent).toContain('49,976–50,000 of 50,000');expect(deep.querySelectorAll('option')).toHaveLength(26);expect([...deep.querySelectorAll('option')].slice(1).map(row=>row.value)).toEqual(fixture.expectedLast);
 const search=formPacket(deep);search.set('managerQuery','PERF000049999');search.set('offset','0');const found=await doc(await post(search));expect(found.body.textContent).toContain('1–1 of 1');expect(found.querySelectorAll('option')).toHaveLength(3);expect(found.querySelector<HTMLSelectElement>('select')!.value).toBe(selectedId);
 const foundId=fixture.expectedLast.at(-2)!;expect(found.querySelector(`option[value="${foundId}"]`)!.textContent).toBe('Fictional retained Personnel 000049999');
 const apply=formPacket(found);apply.set('managerEmploymentId',foundId);apply.set('stage','apply');const applied=await post(apply);expect(applied.status).toBe(303);const url=new URL(applied.headers.get('location')!,'https://hr.example');expect(url.pathname).toBe('/analytics');expect(Object.fromEntries(url.searchParams)).toEqual({departmentId:fixture.b.deptA,from:'2020-01-01',to:'2026-11-07',q:'existing-report-term',year:'2025',hirePage:'1999',hireSize:'25',carryPage:'10',carrySize:'50',managerEmploymentId:foundId});expect(url.href).not.toContain('PERF000049999');
 const foreign=new URLSearchParams(initial);foreign.set('managerEmploymentId',fixture.foreignEmployment);expect((await post(foreign)).status).toBe(403);foreign.set('stage','apply');expect((await post(foreign)).status).toBe(403);
 const [emptyCompany]=await owner.db.insert(company).values({tenantId:fixture.b.tenantId,legalName:'Native selected context with no employees'}).returning();scopeIds=[emptyCompany.id];expect((await post(initial)).status).toBe(403);scopeIds=[fixture.b.companyId];
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,fixture.b.adminUserId));
 expect((await post(initial)).status).toBe(403);const all=new URLSearchParams(initial);all.set('managerEmploymentId','');all.set('stage','apply');expect((await post(all)).status).toBe(403);
 const [after]=await owner.db.select({n:sql<number>`count(*)::int`}).from(domainEvent);expect(after.n).toBe(before.n);
},300000);
