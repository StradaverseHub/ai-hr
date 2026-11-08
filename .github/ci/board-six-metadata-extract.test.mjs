import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {SIX_METADATA_PROFILE as P} from './board-six-metadata-recovery.mjs';
const names=['personnel-draft-discard-premigration-role-prerequisites.json','personnel-draft-discard-role-prerequisites.json'];
function packet(){
 const identity={candidate:P.candidate,controller:P.original,runId:'123',helperSha256:'32aaff3dc2f8a80bfe3e69769422b234e0f607a5dad7c0f4b4cb27e5946a3c54'};
 const fixture={mode:'focused_disposable',postgres:{versionNumber:160015}};
 return {'focused.json':{sha:P.candidate,controller:P.original,runId:'123',attempt:'1',groups:{DB:['test/control.test.ts'],NODB:[]}},'db.vitest.json':{testResults:[]},'postgres.log':'fixture','postgres-state.json':{},'postgres-stats.txt':'fixture',
 [names[0]]:{...identity,kind:'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES',phase:'before_initial_candidate_migration',attempt:'1',fixture,wrapperSha256:'3050abc60faa490cdab416f9aeffc80b0b042daf3891ce2e34fbb42071bc7eec',orchestrationSha256:'61f528c2570c90204e739a37652e7e79d6c3fc5905bbf849209d20c66709492a'},
 [names[1]]:{...identity,...fixture,kind:'PERSONNEL_DRAFT_DISCARD_DISPOSABLE_ROLE_PREREQUISITES'}};
}
function extract(entries,mode=true){
 const root=mkdtempSync(join(tmpdir(),'aihr-six-extract-')),zip=join(root,'input.zip'),out=join(root,'out');
 try{
  const bytes=execFileSync('python3',['-c','import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [(z.writestr(k,v if isinstance(v,str) else json.dumps(v))) for k,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify(entries),maxBuffer:4*1024**2});
  writeFileSync(zip,bytes);const r=spawnSync('python3',[fileURLToPath(new URL('./repair-recovery-extract.py',import.meta.url)),zip,out,...(mode?['--six-metadata-profile']:[])],{encoding:'utf8'});
  return {status:r.status,files:existsSync(out)?readdirSync(out):[],error:r.stderr};
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('exact metadata DB packet retains prerequisite diagnostics in its original ZIP and extracts only the two mandatory JSON records',()=>{
 const r=extract(packet());assert.equal(r.status,0,r.error);assert.deepEqual(r.files.sort(),['db.vitest.json','focused.json']);
});
test('ordinary v2 recovery still refuses these extra diagnostic names',()=>assert.notEqual(extract(packet(),false).status,0));
for(const [name,change] of [
 ['missing premigration proof',p=>delete p[names[0]]],['missing role proof',p=>delete p[names[1]]],['unknown file',p=>p['secret.env']='no'],['oversized prerequisite',p=>p[names[0]]='x'.repeat(1024**2+1)],
 ['foreign candidate',p=>p['focused.json'].sha='f'.repeat(40)],['foreign report controller',p=>p['focused.json'].controller='f'.repeat(40)],['report rerun',p=>p['focused.json'].attempt='2'],
 ['foreign proof candidate',p=>p[names[0]].candidate='f'.repeat(40)],['foreign run',p=>p[names[1]].runId='456'],['foreign helper',p=>p[names[1]].helperSha256='f'.repeat(64)],['foreign wrapper',p=>p[names[0]].wrapperSha256='f'.repeat(64)],['wrong orchestration',p=>p[names[0]].orchestrationSha256='f'.repeat(64)],
 ['wrong prerequisite phase',p=>p[names[0]].phase='after'],['wrong proof kind',p=>p[names[1]].kind='other'],['installation mode',p=>p[names[1]].mode='live'],['different PostgreSQL major',p=>p[names[0]].fixture.postgres.versionNumber=170001],
 ['missing database health log',p=>delete p['postgres.log']],['mixed results',p=>p['nodb.vitest.json']={}],['diagnostic path traversal',p=>p['../outside.json']={}],
])test('metadata extractor refuses '+name,()=>{const p=packet();change(p);assert.notEqual(extract(p).status,0);});
test('no-DB metadata packet cannot carry database diagnostics',()=>{
 const p=packet();p['focused.json'].groups={NODB:['test/control.test.ts'],DB:[]};p['nodb.vitest.json']=p['db.vitest.json'];delete p['db.vitest.json'];for(const n of ['postgres.log','postgres-state.json','postgres-stats.txt',...names])delete p[n];assert.equal(extract(p).status,0);p[names[0]]={};assert.notEqual(extract(p).status,0);
});

test('the exact metadata profile admits the observed239-member screenshot packet without raising byte/member limits for v2',()=>{
 const p=packet();p['focused.json'].groups={NODB:['test/control.test.ts'],DB:[]};p['nodb.vitest.json']=p['db.vitest.json'];delete p['db.vitest.json'];for(const n of ['postgres.log','postgres-state.json','postgres-stats.txt',...names])delete p[n];
 for(let i=0;i<237;i++)p[`ui-screenshots/fixture-${i}.png`]='opaque diagnostic';
 assert.equal(Object.keys(p).length,239);assert.equal(extract(p).status,0);assert.notEqual(extract(p,false).status,0);
 p['ui-screenshots/one-too-many.png']='opaque diagnostic';assert.notEqual(extract(p).status,0);
});
