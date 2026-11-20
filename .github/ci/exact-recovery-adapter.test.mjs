/** Synthetic transport fixtures only: real API pagination, ZIP digest and closed extractor, never a CI witness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectRecoveryEvidence} from './focused-recovery.mjs';
test('Real collector retains all API pages and authenticated DB diagnostics while extracting accounting JSON only',async()=>{
 const root=mkdtempSync(join(tmpdir(),'exact-recovery-api-')),bin=join(root,'bin'),api=join(root,'api'),directory=join(root,'evidence');mkdirSync(bin);mkdirSync(api);
 const members={'focused.json':JSON.stringify({kind:'FOCUSED_ONLY',schemaVersion:1,releaseEligible:false,sha:'a'.repeat(40),controller:'b'.repeat(40),runId:'200',attempt:'1',groups:{NODB:[],DB:['test/a.test.ts']},files:['test/a.test.ts'],exitCode:0}),
  'db.vitest.json':'{}','postgres.log':'synthetic native diagnostic','postgres-state.json':'{}','postgres-stats.txt':'{}','profile-summary.json':'{}','harness-profile/profile-123-setup.jsonl':'{}\n'};
 const zip=join(api,'400.zip');execFileSync('python3',['-I','-B','-c','import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,value in json.load(sys.stdin).items():z.writestr(name,value)',zip],{input:JSON.stringify(members)});
 const bytes=readFileSync(zip),artifact={id:400,name:'focused-development-evidence',expired:false,size_in_bytes:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
 const state={run:{id:200,status:'completed',conclusion:'success',run_attempt:1},jobs:Array.from({length:101},(_,i)=>({id:1000+i,name:'synthetic-job-'+i})),artifacts:[artifact]};
 const stateFile=join(api,'state.json');writeFileSync(stateFile,JSON.stringify(state));
 writeFileSync(join(bin,'gh'),'#!'+process.execPath+'\n'+
  'const fs=require("node:fs"),raw=process.argv[3],p=raw.split("?")[0],q=new URLSearchParams(raw.split("?")[1]),s=JSON.parse(fs.readFileSync(process.env.AIHR_FAKE_EXACT_API+"/state.json"));'+
  'if(p.endsWith("/jobs")){const n=Number(q.get("page"));process.stdout.write(JSON.stringify({jobs:s.jobs.slice((n-1)*100,n*100)}));}'+
  'else if(p.endsWith("/artifacts"))process.stdout.write(JSON.stringify({artifacts:s.artifacts}));'+
  'else if(p.endsWith("/400/zip"))process.stdout.write(fs.readFileSync(process.env.AIHR_FAKE_EXACT_API+"/400.zip"));else process.stdout.write(JSON.stringify(s.run));\n',{mode:0o700});
 const oldPath=process.env.PATH,oldApi=process.env.AIHR_FAKE_EXACT_API;process.env.PATH=bin+':'+oldPath;process.env.AIHR_FAKE_EXACT_API=api;
 try{
  const first=await collectRecoveryEvidence(200,directory,{exactPackets:true});assert.equal(first.jobs.length,101);assert.equal(first.jobs.at(-1).id,1100);
  assert.deepEqual([...first.parsed.get('focused-development-evidence').keys()].sort(),['db.vitest.json','focused.json']);
  assert.equal(first.archives.get('focused-development-evidence').equals(bytes),true);
  const repeated=await collectRecoveryEvidence(200,directory,{exactPackets:true,reuse:true});assert.equal(repeated.jobs.length,101);
  state.artifacts[0].digest='sha256:'+'0'.repeat(64);writeFileSync(stateFile,JSON.stringify(state));
  await assert.rejects(collectRecoveryEvidence(200,directory,{exactPackets:true,reuse:true}));
 }finally{process.env.PATH=oldPath;if(oldApi===undefined)delete process.env.AIHR_FAKE_EXACT_API;else process.env.AIHR_FAKE_EXACT_API=oldApi;rmSync(root,{recursive:true,force:true});}
});
