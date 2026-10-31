import {beforeEach,it,expect,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),fields:vi.fn(),heads:vi.fn(),signers:vi.fn(),employees:vi.fn(),delegates:vi.fn(),assets:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({listLetterFields:mocks.fields,listLetterTemplateHeads:mocks.heads,listLetterSignatories:mocks.signers,listLetterEmployeeChoices:mocks.employees,listLetterDelegates:mocks.delegates,listLetterSettingAssets:mocks.assets}));
import {GET} from '../app/(app)/letters/templates/options/route';
const companyId='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',ctx={tenantId:'fixture',userId:'actual-user'};
const request=(kind='field',extra='')=>new Request(`https://fixture.test/letters/templates/options?companyId=${companyId}&kind=${kind}${extra}`);
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);});
it('uses the fresh session and returns only active current mappings with their explicit cursor',async()=>{
 const definition={key:'employeeName',label:'Employee name',description:'Name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false};mocks.fields.mockResolvedValue({items:[{id,key:'employeeName',definition,active:true,ordinal:3},{id:'inactive',key:'old',definition,active:false,ordinal:1}],nextCursor:'employeeName'});
 const response=await GET(request('field','&q=name&after=employeeCode'));expect(mocks.fields).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,search:'name',after:'employeeCode',limit:25});expect(await response.json()).toEqual({rows:[{id,label:'Employee name · employeeName',field:{definition,ordinal:3}}],nextCursor:'employeeName'});expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
});
it('returns safe head/signatory metadata without echoing private source columns',async()=>{
 for(const [kind,owner]of [['letterhead',mocks.heads],['signatory',mocks.signers]] as const){owner.mockResolvedValue({rows:[{id,name:'Fixture choice',content:'PRIVATE SIGNATURE',workosUserId:'PRIVATE SUBJECT'}],nextCursor:id});const response=await GET(request(kind));expect(await response.json()).toEqual({rows:[{id,label:'Fixture choice'}],nextCursor:id});expect(owner).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,search:undefined,cursor:undefined,limit:25});}
});
it('keeps employee selection in the scoped Workforce owner and returns no private contact fields',async()=>{
 mocks.employees.mockResolvedValue({rows:[{employmentId:id,name:'Fictional employee',employeeCode:'0007',email:'PRIVATE CONTACT'}],nextCursor:id});const response=await GET(request('employee','&q=0007&branch=North&hiredFrom=2025-01-01&hiredTo=2025-12-31'));expect(await response.json()).toEqual({rows:[{id,label:'Fictional employee · 0007'}],nextCursor:id});expect(mocks.employees).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,search:'0007',cursor:undefined,limit:25,departmentId:undefined,departmentSearch:undefined,branch:'North',hiredFrom:'2025-01-01',hiredTo:'2025-12-31'});
});
it('refuses malformed identities and closed kinds before reaching any owner',async()=>{
 for(const value of [request('signature-bytes'),request('field','&after=invalid%20field'),request('signatory','&after=employeeName'),new Request('https://fixture.test/letters/templates/options?companyId=foreign&kind=field')])expect((await GET(value)).status).toBe(400);expect(mocks.fields).not.toHaveBeenCalled();expect(mocks.heads).not.toHaveBeenCalled();expect(mocks.signers).not.toHaveBeenCalled();
});
it('keeps permission and expired-session failures private',async()=>{
 mocks.session.mockRejectedValue(new AuthRequiredError());expect((await GET(request())).status).toBe(401);mocks.session.mockResolvedValue(ctx);
 for(const [error,status,code]of [[new LetterWorkflowError('permission'),403,'permission'],[new Error('PRIVATE SQL DETAIL'),503,'unavailable']] as const){mocks.fields.mockRejectedValue(error);const response=await GET(request());expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});}
});

it('binds delegation choices to one authorized letter and strips private candidate columns',async()=>{
 mocks.delegates.mockResolvedValue({rows:[{id,name:'Eligible reviewer',email:'PRIVATE CONTACT'}],nextCursor:null});const response=await GET(request('delegate','&letterId='+id+'&q=review'));
 expect(await response.json()).toEqual({rows:[{id,label:'Eligible reviewer'}],nextCursor:null});expect(mocks.delegates).toHaveBeenCalledExactlyOnceWith(ctx,{letterId:id,search:'review',cursor:undefined,limit:25});
 mocks.delegates.mockClear();expect((await GET(request('delegate'))).status).toBe(400);expect(mocks.delegates).not.toHaveBeenCalled();
});

it('passes the chosen signature owner to the metadata-only settings reader',async()=>{
 mocks.assets.mockResolvedValue({rows:[{id,name:'Owner signature',ownerUserId:id,content:'PRIVATE PIXELS'}],nextCursor:null});const response=await GET(request('signature','&ownerUserId='+id));expect(await response.json()).toEqual({rows:[{id,label:'Owner signature'}],nextCursor:null});expect(mocks.assets).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,kind:'signature',ownerUserId:id,search:undefined,cursor:undefined,limit:25});mocks.assets.mockClear();expect((await GET(request('signature','&ownerUserId=foreign'))).status).toBe(400);expect(mocks.assets).not.toHaveBeenCalled();
});
