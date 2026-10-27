/** Reconstruct the exact frozen source and original policy3 plan; no test execution or release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export async function bonusRepairSource({repository}){
const base='e07a86340d1ced979868bf4359d73597301d0f15',head='d52563c666d39074217ed42191866add4a2793a0';
const component='app/rewards/[unitId]/bonus-budget.tsx',test='test/rewards-bonus-budget.dom.test.tsx';
const git=(...args)=>execFileSync('git',args,{cwd:repository,encoding:'utf8',maxBuffer:128*1024**2,timeout:30000});
assert.equal(git('rev-parse','HEAD').trim(),head);assert.equal(git('status','--porcelain').trim(),'');
assert.equal(git('rev-parse',head+'^').trim(),base);
assert.deepEqual(git('diff','--name-only',base,head).trim().split('\n').sort(),[component,test].sort());
const original=git('show',base+':'+component),repaired=git('show',head+':'+component);
assert.equal(original.replace("formatMoney(cents,'MYR')","formatMoney(cents/100,'MYR')"),repaired);
const modules=await Promise.all(['scripts/gate-impact.ts','scripts/gate-tier-git.ts'].map(p=>import(pathToFileURL(join(repository,p)).href)));
const parser={...(modules[0].default??{}),...modules[0]},changes={...(modules[1].default??{}),...modules[1]};assert.equal(parser.IMPACT_POLICY_VERSION,3);
const rows=git('ls-tree','-rz',head).split('\0').filter(Boolean).map(r=>{const m=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(r);assert(m);return {mode:m[1],kind:m[2],id:m[3],path:m[4]};}).filter(e=>/\.(?:[cm]?[jt]sx?|json|css|md)$/.test(e.path));
assert(rows.every(e=>['100644','100755'].includes(e.mode)&&e.kind==='blob'));
const ids=[...new Set(rows.map(e=>e.id))],raw=execFileSync('git',['cat-file','--batch'],{cwd:repository,input:ids.join('\n')+'\n',maxBuffer:128*1024**2,timeout:30000}),blobs=new Map();let cursor=0;
for(const id of ids){const end=raw.indexOf(10,cursor);assert(end>cursor);const [actual,kind,n]=raw.subarray(cursor,end).toString().split(' '),size=Number(n);assert(actual===id&&kind==='blob'&&Number.isSafeInteger(size)&&size>=0);cursor=end+1;const b=raw.subarray(cursor,cursor+size);assert.equal(b.length,size);assert.equal(raw[cursor+size],10);assert.equal(createHash('sha1').update(Buffer.from('blob '+size+'\0')).update(b).digest('hex'),id);blobs.set(id,b.toString());cursor+=size+1;}assert.equal(cursor,raw.length);
const plan=parser.planImpact(changes.collectChanges(base,head,repository),new Map(rows.map(e=>[e.path,blobs.get(e.id)])),[]);
const source={base,head,tree:git('rev-parse',head+'^{tree}').trim(),changedFiles:[component,test],actualPolicy:3,plan,controller:'e33213148f71d71bbeabfcf3333cfc5d9a2a2058',runId:'40509167972',releaseAuthorized:false,fullGatePassCreated:false};
return source;

}
