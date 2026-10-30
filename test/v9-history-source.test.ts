import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const mock=vi.hoisted(()=>({command:vi.fn()}));
vi.mock('node:child_process',async()=>({...await vi.importActual<typeof import('node:child_process')>('node:child_process'),execFileSync:mock.command}));
import {bindHistoryApplications} from '../.github/ci/v9-history-source.mjs';
import {V9_DB_CASE as pin,checkHistory} from '../.github/ci/v9-db-resource-policy.mjs';
import {digest,REPOSITORY_ID} from '../.github/ci/release-policy.mjs';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});vi.clearAllMocks();});
function fixture():any{
 const now=Date.now(),at=(s:number)=>new Date(now+s*1000).toISOString(),directory=mkdtempSync(join(tmpdir(),'v9-history-binding-'));dirs.push(directory);
 const row={id:999,head_sha:pin.controller,head_branch:'main',workflow_id:55,run_attempt:1,status:'completed',conclusion:'failure',created_at:at(-100),updated_at:at(-10),display_title:'Focused only · alias-not-in-original-title'};
 const bytes=Buffer.from('API-authenticated ZIP fixture'),packet={sha:pin.candidate,controller:pin.controller,kind:'FOCUSED_ONLY',runId:'999',attempt:'1'};
 const artifact={id:555,name:'focused-development-evidence',expired:false,size_in_bytes:bytes.length,digest:digest(bytes),created_at:at(-30),expires_at:at(3600),workflow_run:{id:999,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:pin.controller,head_branch:'main'}};
 const job={id:888,name:'selected-tests',run_id:999,head_sha:pin.controller,run_attempt:1,status:'completed',started_at:at(-90),completed_at:at(-20)};
 const m={run:{...row},jobs:[job],artifacts:[artifact]};mock.command.mockImplementation((cmd:string)=>cmd==='gh'?bytes:JSON.stringify(packet));
 return {rows:[row],original:{id:pin.runId,updated_at:at(-200)},focusedRunId:321,metadata:vi.fn(()=>m),directory,m,packet,bytes,now,at};
}
it('resolves a failed same-source execution through another alias using API/digest-bound packet identity',()=>{
 const f=fixture(),bindings=bindHistoryApplications(f);expect(bindings.get(999)).toMatchObject({source:pin.candidate,runId:999,authenticated:true,digest:digest(f.bytes)});
 const original={...f.rows[0],id:pin.runId,display_title:`Alpha CI · ${pin.branch}`,updated_at:f.original.updated_at,created_at:f.at(-300),conclusion:'failure'},focused={...f.rows[0],id:321,display_title:`Focused only · ${pin.branch}`,conclusion:'success'};
 expect(()=>checkHistory([original,focused,...f.rows],{original,focusedRunId:321,workflowIds:[55],bindings,now:f.now})).toThrow('Unaccounted');
});
it.each([
 ['tampered ZIP',(f:any)=>{mock.command.mockImplementation((cmd:string)=>cmd==='gh'?Buffer.from('changed'):JSON.stringify(f.packet));}],
 ['foreign API artifact',(f:any)=>{f.m.artifacts[0].workflow_run.id=123;}],
 ['wrong source controller',(f:any)=>{f.packet.controller='f'.repeat(40);}],
 ['wrong report run',(f:any)=>{f.packet.runId='777';}],
 ['non-SHA binding',(f:any)=>{f.packet.sha='alias';}],
] as const)('refuses %s in the real source-binding adapter',(name,change)=>{const f=fixture();change(f);expect(()=>bindHistoryApplications(f)).toThrow();});
it('leaves active/missing or untrusted bindings unresolved rather than inferring a mutable ref',()=>{
 for(const change of [(f:any)=>{f.m.artifacts=[];},(f:any)=>{f.m.jobs[0].status='in_progress';},(f:any)=>{f.rows[0].head_sha='f'.repeat(40);f.m.run.head_sha='f'.repeat(40);}]){const f=fixture();change(f);expect(bindHistoryApplications(f).size).toBe(0);}
});
