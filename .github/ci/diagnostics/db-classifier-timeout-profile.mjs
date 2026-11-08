/** Fixed original classifier profile. Metadata only; no classification adoption. */
import assert from 'node:assert/strict';
import {readFileSync,statSync,lstatSync,realpathSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const selector='test/gate-db-classifier-timeout-diagnostic.test.ts';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>process.hrtime.bigint();
function ownStat(pid){const text=readFileSync('/proc/'+pid+'/stat','utf8'),end=text.lastIndexOf(') ');assert(end>0);const fields=text.slice(end+2).trim().split(/\s+/);return{pid,parent:Number(fields[1]),group:Number(fields[2]),session:Number(fields[3]),start:fields[19],state:fields[0]};}
export async function runOriginalClassifierProfile(){
 assert.equal(process.platform,'linux');assert.equal(process.versions.node,'22.23.3');assert.equal(process.argv.length,2);assert.equal(realpathSync(process.argv[1]),fileURLToPath(import.meta.url));
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.deepEqual(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'null'),[selector]);
 const source=realpathSync(process.cwd()),workspace=realpathSync(process.env.GITHUB_WORKSPACE),out=join(realpathSync(process.env.RUNNER_TEMP),'aihr-focused','db-classifier-timeout');assert.equal(source,join(workspace,'source'));assert.equal(realpathSync(out),out);
 const self=ownStat(process.pid),monitor=ownStat(self.parent),owner=ownStat(monitor.parent);assert(self.group===monitor.pid&&self.session===monitor.pid&&monitor.group===monitor.pid&&monitor.session===monitor.pid);
 const argv=pid=>readFileSync('/proc/'+pid+'/cmdline').subarray(0,-1).toString('utf8').split('\0');
 const expected=['/usr/bin/python3','-I','-B',join(source,'.github/ci/diagnostics/db-classifier-timeout.py')];assert.deepEqual(argv(monitor.pid),expected);assert.deepEqual(argv(owner.pid),expected);assert.equal(realpathSync('/proc/'+owner.pid+'/exe'),realpathSync('/usr/bin/python3'));
 const ownedJson=name=>{const path=join(out,name),stat=lstatSync(path);assert(stat.isFile()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o077)===0&&stat.size>0&&stat.size<=4*1024*1024&&realpathSync(path)===path);return JSON.parse(readFileSync(path,'utf8'));};
 const binding=ownedJson('binding.json'),clock=ownedJson('profile-clock.json');assert.equal(binding.source,process.env.AIHR_CI_HEAD);assert.equal(binding.run,process.env.GITHUB_RUN_ID);assert.equal(clock.workSeconds,15);assert.equal(clock.source,binding.source);assert.equal(clock.run,binding.run);assert.equal(typeof clock.startSeconds,'number');
 const origin=BigInt(Math.round(clock.startSeconds*1e9)),check=()=>assert(now()-origin<15000000000n,'Original profile work frontier exhausted');
 const totals={readerCalls:0,statCalls:0,statFailures:0,readCalls:0,readFailures:0,bytesAtSuccessfulReadStat:0,statNs:'0',readNs:'0',hashNs:'0',progressNs:'0'};let statNs=0n,readNs=0n,hashNs=0n,progressNs=0n,ordinal=-1,completed=0,sequence=0,lastSource=null;
 function progress(stage){
  const before=now();Object.assign(totals,{statNs:String(statNs),readNs:String(readNs),hashNs:String(hashNs),progressNs:String(progressNs)});
  const value={version:1,kind:'ORIGINAL_CLASSIFIER_PARTIAL_PROFILE_NOT_ACCEPTANCE',source:binding.source,run:binding.run,stage,sequence:sequence++,ordinal,completed,suiteCount:binding.suiteCount,elapsedNs:String(before-origin),totals:{...totals},lastSource,classificationAdopted:false};
  const raw=JSON.stringify(value)+'\n';assert(Buffer.byteLength(raw)<=8192);const pending=join(out,'profile-progress.pending'),path=join(out,'profile-progress.json');writeFileSync(pending,raw,{flag:'wx',mode:0o600});renameSync(pending,path);progressNs+=now()-before;
 }
 progress('worker-start-before-input');check();const input=readFileSync(0,'utf8');assert.equal(sha(Buffer.from(input)),binding.stdinSha256);const files=input.split('\n').map(value=>value.trim()).filter(Boolean);assert.equal(files.length,binding.suiteCount);assert.equal(sha(Buffer.from(JSON.stringify(files))),binding.suiteSha256);progress('input-complete-before-import');check();
 const reference=join(out,'classifier-reference.ts'),referenceBytes=readFileSync(reference);assert.equal(sha(referenceBytes),binding.classifierSha256);assert(!/gate-db-classify\.ts$/.test(reference));
 const actual=await import(pathToFileURL(reference).href);assert.equal(typeof actual.classifyTestFile,'function');progress('original-export-imported');check();
 // Same real shared per-request cache and root order as classifyTestFiles.
 // Reader stat/read and catch-to-null semantics are the original CLI's exact
 // operations. Instrumentation costs are separately retained, never hidden IO.
 const read=path=>{
  check();totals.readerCalls++;let before=now();lastSource={readerOrdinal:totals.readerCalls,pathSha256:sha(Buffer.from(path)),decodedSourceSha256:null,bytesAtStat:null};hashNs+=now()-before;progress('before-native-reader');
  totals.statCalls++;let stat,failed=false;before=now();try{stat=statSync(path);}catch{totals.statFailures++;failed=true;}finally{statNs+=now()-before;}
  if(failed){progress('native-reader-unavailable');return null;}if(!stat.isFile()){progress('native-reader-nonfile');return null;}
  totals.readCalls++;let text;before=now();try{text=readFileSync(path,'utf8');}catch{totals.readFailures++;failed=true;}finally{readNs+=now()-before;}
  if(failed){progress('native-reader-unavailable');return null;}
  before=now();lastSource={...lastSource,decodedSourceSha256:sha(Buffer.from(text)),bytesAtStat:stat.size,decodedCodeUnits:text.length};hashNs+=now()-before;totals.bytesAtSuccessfulReadStat+=stat.size;progress('after-native-reader-before-classification');check();return text;
 };
 const cache=new Map(),db=[],nodb=[],why=new Map();
 for(ordinal=0;ordinal<files.length;ordinal++){
  check();lastSource=null;progress('before-original-root');const verdict=actual.classifyTestFile(files[ordinal],read,cache);check();(verdict.db?db:nodb).push(files[ordinal]);why.set(files[ordinal],verdict.reason);completed++;progress('after-original-root');
 }
 // Preserve the original final output pass, including its membership lookup.
 check();progress('before-original-output');for(const file of files)console.log(`${db.includes(file)?'DB':'NODB'}\t${file}\t${why.get(file)}`);progress('original-output-complete');check();
 const final=ownStat(process.pid);for(const key of ['pid','parent','group','session','start'])assert.equal(final[key],self[key]);return{complete:true,classificationAdopted:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runOriginalClassifierProfile();
