import {beforeEach,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
// The installed test runtime has no declaration; type only its used constructor.
const JSDOM=createRequire(import.meta.url)('jsdom').JSDOM as new(html:string)=>{window:{document:Document}};
import {createTranslator} from 'next-intl';
import messages from '../messages/en.json';
const mocks=vi.hoisted(()=>({scope:vi.fn(),read:vi.fn(),selected:vi.fn(),principal:vi.fn(),theme:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:mocks.scope}));
vi.mock('../db/client',()=>({withTenant:async(s:unknown,read:(tx:unknown)=>Promise<unknown>)=>read({session:s})}));
vi.mock('../core/ai-principal',()=>({assertAiPresentationPrincipalTx:mocks.principal}));
vi.mock('../core/analytics',()=>({analyticsManagerSelection:mocks.selected}));
vi.mock('../core/employee-choice',()=>({readEmployeeChoices:mocks.read,EmployeeChoiceInputError:class extends Error{},EmployeeChoiceAccessError:class extends Error{}}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async(namespace:'employeePanel'|'analytics')=>createTranslator({locale:'en',messages:messages[namespace]})}));
vi.mock('../lib/ui-theme-server',()=>({currentUiTheme:mocks.theme}));
vi.mock('next/navigation',()=>({unstable_rethrow:(error:unknown)=>{if(error instanceof Error&&error.message.startsWith('NEXT_REDIRECT'))throw error;}}));
import {AiGatewayError} from '../lib/ai/types';
import {POST} from '../app/analytics/manager-choices/route';
const selectedId='00000000-0000-0000-0000-000000050000';
const session={tenantId:'trusted',userId:'native-admin',roles:['hr_admin']};
const id=(n:number)=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
function packet(){return new URLSearchParams({companyId:'report-company',departmentId:'report-dept',managerEmploymentId:selectedId,from:'2026-01-01',to:'2026-11-07',choiceContext:JSON.stringify({companyId:'old-company',q:'legacy-report-query',year:'2025',hirePage:'17',hireSize:'50',termPage:'3',termSize:'100',changePage:'8',changeSize:'25',carryPage:'7',carrySize:'all'})});}
function request(body:URLSearchParams|string=packet(),extra:Record<string,string>={}){return new Request('https://hr.example/analytics/manager-choices',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/x-www-form-urlencoded',...extra},body});}
async function doc(response:Response){return new JSDOM(await response.text()).window.document;}
function formPacket(document:Document){const form=document.querySelector('form')!;const result=new URLSearchParams();for(const field of form.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[name],select[name]'))result.append(field.name,field.value);return result;}
beforeEach(()=>{
 vi.clearAllMocks();mocks.scope.mockResolvedValue({s:session,scopeIds:['fresh-scope']});mocks.principal.mockResolvedValue(undefined);mocks.theme.mockResolvedValue('classic');
 mocks.selected.mockImplementation(async(_s:unknown,_scope:unknown,value:string)=>value?{employmentId:value,name:'Pinned <img src=x onerror=alert(1)>'}:null);
 mocks.read.mockImplementation(async(_s:unknown,input:{offset:number})=>({rows:Array.from({length:25},(_,i)=>({employmentId:id(input.offset+i+1),name:'Employee '+(input.offset+i+1)})),total:50000}));
});
it('renders a native 25-choice page plus independently authorized deep selection and real count after explicit POST',async()=>{
 const response=await POST(request());expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
 const page=await doc(response);expect(page.querySelector('script,img')).toBeNull();expect(page.documentElement.dataset.uiTheme).toBe('classic');expect(page.documentElement.lang).toBe('en');
 expect(page.querySelectorAll('option')).toHaveLength(27);expect(page.querySelector<HTMLSelectElement>('select')!.value).toBe(selectedId);expect(page.body.textContent).toContain('1–25 of 50,000');
 expect(page.body.textContent).toContain('Pinned <img src=x onerror=alert(1)>');expect(mocks.selected).toHaveBeenCalledWith(session,['fresh-scope'],selectedId);
 expect(mocks.read).toHaveBeenCalledWith(session,{query:'',offset:0,limit:25,labelMode:'names',selectedId,companyIds:['fresh-scope']},expect.any(AbortSignal));
 expect(mocks.principal).toHaveBeenCalledOnce();expect(page.querySelector('form')!.getAttribute('action')).toBe('/analytics/manager-choices');
});
it('retains valid uppercase bookmarked UUIDs through browse, pinning and Apply',async()=>{
 const canonical='abcdef01-2345-6789-abcd-ef0123456789',body=packet();
 body.set('managerEmploymentId',canonical.toUpperCase());
 mocks.selected.mockResolvedValue({employmentId:canonical,name:'Bookmarked manager'});
 const page=await doc(await POST(request(body)));
 expect(page.querySelector<HTMLSelectElement>('select')!.value).toBe(canonical);
 expect(mocks.selected).toHaveBeenCalledWith(session,['fresh-scope'],canonical);
 expect(mocks.read).toHaveBeenCalledWith(session,expect.objectContaining({selectedId:canonical}),expect.any(AbortSignal));
 body.set('stage','apply');const applied=await POST(request(body));
 expect(applied.status).toBe(303);
 expect(new URL(applied.headers.get('location')!,'https://hr.example').searchParams.get('managerEmploymentId')).toBe(canonical);
});
it('browses, searches and applies through only native POST controls, retaining every submitted report field and no new raw search in URLs',async()=>{
 const first=await doc(await POST(request()));let body=formPacket(first);body.set('offset','49975');
 const deep=await doc(await POST(request(body)));expect(deep.body.textContent).toContain('49,976–50,000 of 50,000');expect(deep.querySelectorAll('option')).toHaveLength(26);
 expect(deep.querySelector<HTMLButtonElement>('button[name="offset"][value="50000"]')!.disabled).toBe(true);
 body=formPacket(deep);body.set('managerQuery','PRIVATE_<script>alert(1)</script>');body.set('offset','0');
 const search=await doc(await POST(request(body)));expect(search.querySelector('script')).toBeNull();expect(search.querySelector<HTMLInputElement>('[name="managerQuery"]')!.value).toContain('PRIVATE_');
 for(const el of search.querySelectorAll('a,form'))expect(el.getAttribute('href')??el.getAttribute('action')).not.toContain('PRIVATE_');
 body=formPacket(search);body.set('managerEmploymentId',id(18));body.set('stage','apply');
 const response=await POST(request(body));expect(response.status).toBe(303);const location=response.headers.get('location')!;expect(location).not.toContain('PRIVATE_');expect(location).not.toContain('managerQuery');expect(location).not.toContain('choiceContext');
 const url=new URL(location,'https://hr.example');expect(url.pathname).toBe('/analytics');expect(Object.fromEntries(url.searchParams)).toEqual({companyId:'report-company',departmentId:'report-dept',from:'2026-01-01',to:'2026-11-07',q:'legacy-report-query',year:'2025',hirePage:'17',hireSize:'50',termPage:'3',termSize:'100',changePage:'8',changeSize:'25',carryPage:'7',carrySize:'all',managerEmploymentId:id(18)});
 const all=packet();all.set('managerEmploymentId','');all.set('stage','apply');mocks.principal.mockClear();mocks.read.mockClear();mocks.selected.mockClear();const cleared=await POST(request(all));expect(cleared.status).toBe(303);expect(cleared.headers.get('location')).not.toContain('managerEmploymentId');expect(mocks.principal).toHaveBeenCalledOnce();expect(mocks.read).not.toHaveBeenCalled();expect(mocks.selected).not.toHaveBeenCalled();
});
it('rechecks current scope and refuses foreign or newly revoked selections instead of dropping to All',async()=>{
 mocks.selected.mockResolvedValue(null);for(const stage of ['browse','apply']){const data=packet();data.set('stage',stage);const response=await POST(request(data));expect(response.status).toBe(403);expect(response.headers.has('location')).toBe(false);expect(await response.text()).not.toContain('Pinned');}expect(mocks.read).not.toHaveBeenCalled();
 mocks.selected.mockResolvedValue({employmentId:selectedId,name:'Safe'});mocks.principal.mockRejectedValue(new AiGatewayError('PRIVATE_PRINCIPAL'));
 const data=packet();data.set('managerEmploymentId','');data.set('stage','apply');expect((await POST(request(data))).status).toBe(403);
 mocks.principal.mockResolvedValue(undefined);mocks.scope.mockResolvedValue({s:{...session,roles:['employee']},scopeIds:[]});expect((await POST(request())).status).toBe(403);
});
it('closes input fields, nested context, duplicates, malformed controls and oversized actual streams',async()=>{
 for(const [key,value] of [['unknown','x'],['stage','write'],['offset','-1'],['offset','1e5'],['managerEmploymentId','bad'],['managerQuery','x'.repeat(1001)],['choiceContext','[1]'],['choiceContext','{"roles":"hr_admin"}'],['choiceContext','{"year":2026}'],['choiceContext','{"year":null}']]){const data=packet();data.set(key,value);expect((await POST(request(data))).status,`${key}: ${value.slice(0,20)}`).toBe(400);}
 const duplicate=packet();duplicate.append('from','2026-02-02');expect((await POST(request(duplicate))).status).toBe(400);
 expect((await POST(request(packet(),{'content-type':'multipart/form-data'}))).status).toBe(400);
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('managerQuery='+'x'.repeat(17000)));controller.close();}});
 expect((await POST(new Request('https://hr.example/analytics/manager-choices',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/x-www-form-urlencoded'},body,duplex:'half'} as RequestInit&{duplex:'half'}))).status).toBe(400);
 expect(mocks.read).not.toHaveBeenCalled();
});
it('refuses cross-origin/bearer/query transports before scope and safely reports read failures while preserving framework redirects',async()=>{
 for(const extra of [{origin:'https://foreign.example'},{origin:''},{'sec-fetch-site':'cross-site'},{authorization:'Bearer x'}])expect((await POST(request(packet(),extra))).status).toBe(403);
 expect(mocks.scope).not.toHaveBeenCalled();expect((await POST(new Request('https://hr.example/analytics/manager-choices?managerQuery=PRIVATE',{method:'POST',headers:{origin:'https://hr.example','content-type':'application/x-www-form-urlencoded'},body:packet()}))).status).toBe(400);
 mocks.read.mockRejectedValue(Error('PRIVATE_SQL'));let response=await POST(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE_SQL');
 mocks.scope.mockRejectedValue(Error('PRIVATE_SCOPE'));response=await POST(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE_SCOPE');
 const redirect=Error('NEXT_REDIRECT;login');mocks.scope.mockRejectedValue(redirect);await expect(POST(request())).rejects.toBe(redirect);
});
