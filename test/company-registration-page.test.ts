import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
const scope=vi.hoisted(()=>({s:null as unknown,scopeIds:[] as string[]}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>scope}));
vi.mock('next-intl/server',()=>({getTranslations:async()=> (key:string,values?:Record<string,unknown>)=>key+(values?JSON.stringify(values):'')}));
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/organization',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}),redirect:vi.fn(),notFound:()=>{throw Error('not found');}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {company,profileOption} from '../db/schema';
import {setCompanyParent} from '../core/admin';
import {companyDisplayGroups} from '../core/company-display-group';
import {changeCompanyRegistrationClassification} from '../core/company-registration-readiness';
import {packFor} from '../localization/registry';
import OrganizationPage from '../app/admin/organization/page';
import {CompanyRows} from '../app/admin/organization/company-rows';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();scope.s=adminCtx(b);scope.scopeIds=[b.companyId];});afterAll(closeAll);
function elements(node:unknown,type:unknown,out:{props:Record<string,unknown>}[]=[]):typeof out{if(!node||typeof node!=='object')return out;if(Array.isArray(node)){for(const c of node)elements(c,type,out);return out;}const n=node as {type:unknown;props?:{children?:unknown}};if(n.type===type)out.push(n as {props:Record<string,unknown>});elements(n.props?.children,type,out);return out;}
it('filters Show in table to the same missing legal employers counted by the alert, before pagination',async()=>{
 const[other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Test entity '+randomUUID()}).returning();await changeCompanyRegistrationClassification(adminCtx(b),{companyId:other.id,entityKind:'legal_entity',isTestEntity:true,expectedRevision:0});
 const[group]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Grouping node'}).returning();await changeCompanyRegistrationClassification(adminCtx(b),{companyId:group.id,entityKind:'grouping_node',isTestEntity:false,expectedRevision:0});
 const tree=await OrganizationPage({searchParams:Promise.resolve({statutory:'missing'})}),rows=elements(tree,CompanyRows)[0].props.rows as {id:string;statutoryStatus:string}[];
 expect(rows.length).toBeGreaterThan(0);expect(rows.some(r=>r.id===b.companyId)).toBe(true);expect(rows.some(r=>r.id===other.id||r.id===group.id)).toBe(false);expect(rows.every(r=>r.statutoryStatus==='missing')).toBe(true);
});
it('shows a company as Complete only once every required registration is present',async()=>{
 await packFor('MY')!.companyStatutory.set(adminCtx(b),{companyId:b.companyId,epfEmployerNo:'ONE',socsoEmployerCode:'TWO',lhdnEmployerNo:'THREE',hrdfStatus:'mandatory'});
 const tree=await OrganizationPage({searchParams:Promise.resolve({statutory:'complete'})}),rows=elements(tree,CompanyRows)[0].props.rows as {id:string;statutoryStatus:string}[];expect(rows.find(r=>r.id===b.companyId)?.statutoryStatus).toBe('complete');
});

it('uses a configured Employment Field in the company listing and preserves the legal parent', async () => {
  const ctx = adminCtx(b);
  const [parent] = await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional legal parent'}).returning();
  const [group] = await owner.db.insert(profileOption).values({tenantId:b.tenantId,category:'division',value:'OPS',label:'Operations'}).returning();
  await setCompanyParent(ctx, {companyId:b.companyId,parentCompanyId:parent.id});
  await setCompanyParent(ctx, {companyId:b.companyId,displayGroup:{field:'division',id:group.id}});
  expect(await companyDisplayGroups(ctx)).toEqual([
    {companyId:b.companyId,field:'division',id:group.id,code:'OPS',label:'Operations'},
  ]);
  const tree = await OrganizationPage({searchParams:Promise.resolve({})});
  expect(elements(tree,CompanyRows)[0].props.rows).toContainEqual(expect.objectContaining({
    id:b.companyId,parentId:parent.id,displayGroup:'displayGrouping.fields.division · OPS – Operations',
  }));
  await expect(setCompanyParent(ctx, {
    companyId:b.companyId,displayGroup:{field:'branch',id:group.id},
  })).rejects.toThrow('Choose an available Employment Field');
  await setCompanyParent(ctx, {companyId:b.companyId,parentCompanyId:parent.id,displayGroup:null});
  expect(await companyDisplayGroups(ctx)).toEqual([]);
});
