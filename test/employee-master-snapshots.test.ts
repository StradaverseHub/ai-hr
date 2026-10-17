/** Real snapshot module loaded under separate module identities; only fresh authorization is mocked. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import type {MasterRun} from '../core/employee-master-reports';
const authorization=vi.hoisted(()=>vi.fn(async()=>{}));
vi.mock('../core/employee-master-reports',()=>({authorizeEmployeeMasterRun:authorization}));
vi.mock('../core/employee-master-access',()=>({MasterReportAccessError:class extends Error{constructor(){super('Report access or selected company/field is unavailable.');this.name='MasterReportAccessError';}}}));
const registry=globalThis as {__aihrMasterSnapshotsV1?:unknown};
const ctx:SessionContext={tenantId:'tenant-a',userId:'actor-a',personId:null,roles:['hr_admin']};
const scope=['company-b','company-a'];
const makeRun=():MasterRun=>({
 reportId:'report-a',version:1,name:'Fictional complete snapshot',catalogue:[],fingerprint:'fixed-authorized-fingerprint',
 spec:{v:2,asAt:'2026-10-17',companyIds:[...scope],includeDrafts:false,columns:[],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}},
 result:{asAt:'2026-10-17',employeeCount:60,personCount:60,draftCount:0,unknownMatchCount:0,unknownScopeCount:0,historyScopeUnavailable:false,totalRows:60,sections:[{id:'employment',grain:'employment',columns:[],rowCount:60,employeeCount:60,personCount:60,draftCount:0,groups:[],totals:[],rows:Array.from({length:60},(_,index)=>({subjectId:'employment-'+index,personId:'person-'+index,kind:'employment',recordId:null,cells:[],group:[],sourceKeys:[]}))}]},
});
async function separateModules(){
 const preview=await import('../core/employee-master-snapshots');
 vi.resetModules();
 const download=await import('../core/employee-master-snapshots');
 expect(download.rememberMasterSnapshot).not.toBe(preview.rememberMasterSnapshot);
 return {preview,download};
}
beforeEach(()=>{delete registry.__aihrMasterSnapshotsV1;vi.resetModules();authorization.mockReset();authorization.mockResolvedValue(undefined);vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));});
afterEach(()=>{delete registry.__aihrMasterSnapshotsV1;vi.useRealTimers();vi.resetModules();});

it('reuses the full authorized preview across distinct server module identities without re-generating rows',async()=>{
 const {preview,download}=await separateModules(),run=makeRun(),before=JSON.stringify(run),token=preview.rememberMasterSnapshot(ctx,scope,run)!;
 expect(await download.employeeMasterSnapshot(ctx,[...scope].reverse(),token,{id:run.reportId!,spec:run.spec})).toBe(run);
 expect(run.result.sections[0].rows).toHaveLength(60);expect(JSON.stringify(run)).toBe(before);
 expect(authorization).toHaveBeenCalledExactlyOnceWith(ctx,[...scope].reverse(),run);
});
it.each(['actor','tenant','scope','report','definition'] as const)('refuses a token with a different %s binding before authorization',async(binding)=>{
 const {preview,download}=await separateModules(),run=makeRun(),token=preview.rememberMasterSnapshot(ctx,scope,run)!;
 const caller=binding==='actor'?{...ctx,userId:'other-actor'}:binding==='tenant'?{...ctx,tenantId:'other-tenant'}:ctx;
 const companies=binding==='scope'?['company-a']:scope;
 const expected={id:binding==='report'?'other-report':run.reportId!,spec:binding==='definition'?{...run.spec,includeDrafts:true}:run.spec};
 await expect(download.employeeMasterSnapshot(caller,companies,token,expected)).rejects.toMatchObject({name:'MasterReportAccessError'});expect(authorization).not.toHaveBeenCalled();
});
it('accepts equivalent definition key order while retaining the saved-versus-unsaved report binding',async()=>{
 const {preview,download}=await separateModules(),run=makeRun(),token=preview.rememberMasterSnapshot(ctx,scope,run)!;
 const reordered=Object.fromEntries(Object.entries(run.spec).reverse());
 await expect(download.employeeMasterSnapshot(ctx,scope,token,{id:run.reportId!,spec:reordered})).resolves.toBe(run);
 await expect(download.employeeMasterSnapshot(ctx,scope,token,{spec:run.spec})).rejects.toMatchObject({name:'MasterReportAccessError'});
});
it('requires fresh authorization even when the token and every stored binding still match',async()=>{
 const {preview,download}=await separateModules(),run=makeRun(),token=preview.rememberMasterSnapshot(ctx,scope,run)!;
 authorization.mockRejectedValueOnce(new Error('Fictional access revoked'));
 await expect(download.employeeMasterSnapshot(ctx,scope,token,{id:run.reportId!,spec:run.spec})).rejects.toThrow('Fictional access revoked');expect(authorization).toHaveBeenCalledOnce();
});
it('fails closed at the exact two-minute expiry without extending the token on read',async()=>{
 const {preview,download}=await separateModules(),run=makeRun(),token=preview.rememberMasterSnapshot(ctx,scope,run)!;
 vi.advanceTimersByTime(119_999);await expect(download.employeeMasterSnapshot(ctx,scope,token,{id:run.reportId!})).resolves.toBe(run);
 vi.advanceTimersByTime(1);await expect(download.employeeMasterSnapshot(ctx,scope,token,{id:run.reportId!})).rejects.toMatchObject({name:'MasterReportAccessError'});expect(authorization).toHaveBeenCalledOnce();
});
it('fails closed for a lost process registry or an unknown token instead of regenerating a snapshot',async()=>{
 const preview=await import('../core/employee-master-snapshots'),run=makeRun(),token=preview.rememberMasterSnapshot(ctx,scope,run)!;
 delete registry.__aihrMasterSnapshotsV1;vi.resetModules();const restarted=await import('../core/employee-master-snapshots');
 for(const lost of [token,'unknown-token'])await expect(restarted.employeeMasterSnapshot(ctx,scope,lost,{id:run.reportId!})).rejects.toMatchObject({name:'MasterReportAccessError'});expect(authorization).not.toHaveBeenCalled();
});
it('shares the eight-entry eviction bound across server module identities',async()=>{
 const {preview,download}=await separateModules(),run=makeRun(),oldest=preview.rememberMasterSnapshot(ctx,scope,run)!;
 for(let index=0;index<8;index++)download.rememberMasterSnapshot(ctx,scope,makeRun());
 await expect(preview.employeeMasterSnapshot(ctx,scope,oldest,{id:run.reportId!})).rejects.toMatchObject({name:'MasterReportAccessError'});expect(authorization).not.toHaveBeenCalled();
});
it('keeps the byte bound across identities and refuses an individually oversized snapshot',async()=>{
 const {preview,download}=await separateModules(),run=makeRun();run.name='x'.repeat(16_100_000);const oldest=preview.rememberMasterSnapshot(ctx,scope,run)!;
 expect(download.rememberMasterSnapshot(ctx,scope,run)).not.toBeNull();
 await expect(preview.employeeMasterSnapshot(ctx,scope,oldest,{id:run.reportId!})).rejects.toMatchObject({name:'MasterReportAccessError'});
 run.name='x'.repeat(32_000_001);expect(preview.rememberMasterSnapshot(ctx,scope,run)).toBeNull();expect(authorization).not.toHaveBeenCalled();
});
