/** Exact reviewed Board repair boundary. Original compiler failure and unknown impact remain recorded. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {typeOnlyRepairSource} from './type-only-repair.mjs';
import {installHash,installJson} from './ci-install-grant.mjs';
export const RUNTIME_REPAIR={original:'e349224b485ee4abb7cb1285a58329dd17d88c74',staging:'9bf924ff3389fd5f5a41c03d062a40c429216585',
 letter:'c10fa3504b98e7b6a43082b5687ca516d3022729',wave:'b3609897299574abef74bad115dd79276a9f1c65',
 backendRepair:'38063a26eb4e40f9800dc23af7da68f75c88d953',candidate:'e07a86340d1ced979868bf4359d73597301d0f15',
 alpha:'dc74b804fcecb4bab3207e82c9b9f099b9bf13be',ciBaseline:'2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f'};
const expected=['app/atelier.css','components/sidebar.tsx','lib/letter-workflow.ts','test/atelier-mobile-navigation.browser.test.tsx','test/letter-workflow.test.ts'];
export async function runtimeRepairSource({repository,candidate}){
 assert(candidate===RUNTIME_REPAIR.candidate,'Only the exact reviewed runtime repair candidate is admitted');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',timeout:10000,maxBuffer:8*1024**2}).trim();
 const changes=(base,head)=>git('diff','--name-only',base,head).split('\n').filter(Boolean).sort();
 const same=(a,b)=>assert(installJson(a)===installJson(b),'Unreviewed source repair boundary');
 for(const [base,head] of [[RUNTIME_REPAIR.original,RUNTIME_REPAIR.staging],[RUNTIME_REPAIR.staging,RUNTIME_REPAIR.letter],[RUNTIME_REPAIR.letter,RUNTIME_REPAIR.wave],[RUNTIME_REPAIR.wave,candidate]])
  execFileSync('git',['-C',repository,'merge-base','--is-ancestor',base,head],{stdio:'pipe'});
 same(changes(RUNTIME_REPAIR.staging,candidate),expected);
 same(changes(RUNTIME_REPAIR.wave,candidate),['test/atelier-mobile-navigation.browser.test.tsx']);
 same(changes(RUNTIME_REPAIR.backendRepair,candidate),['test/atelier-mobile-navigation.browser.test.tsx']);
 assert(git('diff','--name-only',RUNTIME_REPAIR.original,candidate,'--','db','package.json','pnpm-lock.yaml','vitest.config.ts','vitest.nodb.config.ts','vitest.browser.config.ts','tsconfig.json','tsconfig.build.json','scripts/gate-impact.ts','scripts/gate-db-classify.ts')==='','Shared DB/dependency/configuration/classifier inputs changed');
 const typescript=createRequire(new URL('../../package.json',import.meta.url))('typescript');
 const erasedBridge=typeOnlyRepairSource({repository,original:RUNTIME_REPAIR.original,candidate:RUNTIME_REPAIR.staging,compilerCandidate:'e712d8d3d8b36765d297194a8f5e1e281ea5eb26',typescript});
 const pins=expected.map(path=>{assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',candidate,'--',path)),'Regular reviewed application source required');return {path,blob:git('rev-parse',candidate+':'+path)};});
 for(const path of ['scripts/gate-impact.ts','scripts/gate-tier-git.ts'])assert(git('rev-parse',candidate+':'+path)===git('rev-parse',RUNTIME_REPAIR.staging+':'+path),'Actual policy3 source changed');
 assert(git('rev-parse','HEAD')===candidate&&!git('status','--porcelain'),'Clean frozen actual parser source required');
 const parserModule=await import(pathToFileURL(join(repository,'scripts/gate-impact.ts')).href),parser={...(parserModule.default??{}),...parserModule};
 const changeModule=await import(pathToFileURL(join(repository,'scripts/gate-tier-git.ts')).href),changeApi={...(changeModule.default??{}),...changeModule};
 assert(parser.IMPACT_POLICY_VERSION===3,'Actual candidate policy3 required');
 const entries=execFileSync('git',['-C',repository,'ls-tree','-rz',candidate],{maxBuffer:8*1024**2}).toString().split('\0').filter(Boolean).map(row=>{
  const match=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);assert(match,'Malformed immutable source tree');return {mode:match[1],kind:match[2],id:match[3],path:match[4]};
 }).filter(e=>/\.(?:[cm]?[jt]sx?|json|css|md)$/.test(e.path));
 assert(entries.every(e=>['100644','100755'].includes(e.mode)&&e.kind==='blob'),'Regular immutable classifier inputs required');
 const ids=[...new Set(entries.map(e=>e.id))],bytes=execFileSync('git',['-C',repository,'cat-file','--batch'],{input:ids.join('\n')+'\n',maxBuffer:128*1024**2,timeout:30000});
 let cursor=0;const blobs=new Map();
 for(const id of ids){const newline=bytes.indexOf(10,cursor);assert(newline>cursor);const [actual,kind,count]=bytes.subarray(cursor,newline).toString().split(' '),size=Number(count);assert(actual===id&&kind==='blob'&&Number.isSafeInteger(size)&&size>=0&&size<=16*1024**2);cursor=newline+1;const value=bytes.subarray(cursor,cursor+size);assert(value.length===size&&bytes[cursor+size]===10);assert(createHash('sha1').update(Buffer.from('blob '+size+'\0')).update(value).digest('hex')===id);blobs.set(id,value.toString('utf8'));cursor+=size+1;}
 assert(cursor===bytes.length,'Immutable input framing differs');
 const files=new Map(entries.map(e=>[e.path,blobs.get(e.id)]));
 const impacts=[RUNTIME_REPAIR.staging,RUNTIME_REPAIR.letter].map(base=>({base,head:candidate,plan:parser.planImpact(changeApi.collectChanges(base,candidate,repository),files,[])}));
 assert(impacts.every(i=>i.plan.tier==='full'&&i.plan.risk==='unknown'),'Do not silently change the actual unknown/full classification');
 assert(git('rev-parse','HEAD')===candidate&&!git('status','--porcelain'),'Candidate changed during source assessment');
 const body={format:1,kind:'EXACT_BOARD_RUNTIME_REPAIR_SOURCE_NOT_RELEASE',...RUNTIME_REPAIR,
  candidateTree:git('rev-parse',candidate+'^{tree}'),stagingTree:git('rev-parse',RUNTIME_REPAIR.staging+'^{tree}'),
  pins,erasedBridge,impacts,unchangedSharedInputs:true,fixtureOnlyAfterWave:true,originalFailedCompilerPreserved:true,
  actualImpactPolicy:3,actualImpactTier:'full',actualImpactRisk:'unknown',fullGatePassCreated:false,releaseAuthorized:false};
 return {...body,proofSha256:installHash(installJson(body))};
}
