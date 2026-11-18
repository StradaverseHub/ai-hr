import {beforeEach,expect,it,vi} from 'vitest';
import {EmployeeChoiceAccessError} from '../core/employee-choice';
const ports=vi.hoisted(()=>({session:vi.fn(),page:vi.fn(),resolve:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:ports.session}));
vi.mock('../core/bulk-employee-picker',()=>({bulkEmployeePicker:ports.page,resolveBulkEmployeeSelection:ports.resolve}));
import {POST} from '../app/api/bulk-employee-choices/route';
beforeEach(()=>{vi.clearAllMocks();ports.session.mockResolvedValue({tenantId:'fictional'});ports.page.mockResolvedValue({rows:[],total:0,offset:0,query:''});ports.resolve.mockResolvedValue({selection:{ids:[],unmatched:[]},rows:[]});});
const request=(body:unknown,headers:Record<string,string>={})=>new Request('https://hr.example/api/bulk-employee-choices',{method:'POST',headers:{'Origin':'https://hr.example','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
it('uses fresh private POST reads and never accepts caller-owned population filters',async()=>{
 const response=await POST(request({operation:'page',query:'',offset:0}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');expect(ports.page.mock.calls[0][1]).toEqual({query:'',offset:0,all:false});
 expect((await POST(request({operation:'all',query:'',offset:0,companyIds:[]}))).status).toBe(400);
 expect((await POST(request({operation:'page',query:'',offset:0},{Origin:'https://foreign.example'}))).status).toBe(403);
 expect((await POST(request({operation:'page',query:'',offset:0},{Authorization:'Bearer fixture'}))).status).toBe(403);
});
it('passes explicit complete IDs and raw paste together, with a disconnect signal and native refusal',async()=>{
 const input={operation:'resolve',picked:['unknown'],raw:'P 0008'};expect((await POST(request(input))).status).toBe(200);expect(ports.resolve.mock.calls[0].slice(1,3)).toEqual([input.picked,input.raw]);expect(ports.resolve.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
 ports.page.mockRejectedValue(new EmployeeChoiceAccessError());expect((await POST(request({operation:'page',query:'',offset:0}))).status).toBe(403);
 ports.resolve.mockRejectedValue(new Error('private internal detail'));const unavailable=await POST(request(input));expect(unavailable.status).toBe(503);expect(await unavailable.json()).toEqual({error:'unavailable'});
});
