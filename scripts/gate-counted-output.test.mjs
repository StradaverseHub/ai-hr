import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const current=readFileSync(fileURLToPath(new URL('./gate-chunked.sh',import.meta.url)),'utf8');
function fn(source,name){
 const start=source.indexOf(`${name}() {`),end=source.indexOf('\n}',start);
 assert(start>=0 && end>start && end-start>100,`Missing substantive ${name}`);
 return source.slice(start,end+2);
}
const fixed=fn(current,'vitest_summary_line')+'\n'+fn(current,'check_counted');
const dir=mkdtempSync(join(tmpdir(),'aihr-counter-test-'));let checks=0;
function check(text,asked=2,incoming=0,functions=fixed){
 const path=join(dir,`case-${checks++}.log`);writeFileSync(path,text);
 const r=spawnSync('bash',['-c',functions+'\nRC=$3;check_counted "$1" "$2";printf "\\n__RESULT__%s|%s\\n" "$RC" "$COUNTED"','counter-test',path,String(asked),String(incoming)],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const result=r.stdout.match(/__RESULT__(\d+)\|([^\n]*)/);assert(result,r.stdout);
 return {rc:Number(result[1]),count:result[2]};
}
try{
 const plain=' Test Files  2 passed (2)\n      Tests  7 passed (7)\n   Duration  1s\n';
 const colored=plain.split('\n').map(line=>'\x1b[2m'+line+'\x1b[39m\x1b[22m').join('\n');
 assert.deepEqual(check(plain),{rc:0,count:'2'});
 assert.deepEqual(check(colored),{rc:0,count:'2'});
 assert.equal(check(colored,2,7).rc,7,'Actual nonzero process status must survive parsing');
 for(const bad of ['', ' Test Files 2 passed (2', plain.replace('(2)','(3)'),plain.replace('2 passed','1 passed | 1 failed'),plain.replace('2 passed','1 passed | 1 skipped'),plain.replace('7 passed','6 passed | 1 skipped'),plain.replace('7 passed (7)','6 passed (7)'),plain.replace('      Tests  7 passed (7)\n',''),plain+plain,plain+' Test Files 2 passed (2)\n',plain.replace('7 passed (7)','0 passed (0)'),plain.replace('   Duration  1s\n',''),plain+' Duration 1s\n',plain.replace('Duration  1s','Duration unknown')])assert.equal(check(bad).rc,1,'Incomplete/ambiguous/nonpassing summary must refuse');
 assert.equal(check(plain,3).rc,1,'Requested count mismatch must refuse');
 if(process.argv[2]){
  const raw=readFileSync(process.argv[2],'utf8');assert.deepEqual(check(raw,963),{rc:0,count:'963'});
  assert.equal(check(raw,963,9).rc,9);
  if(process.argv[3]){
   const original=fn(readFileSync(process.argv[3],'utf8'),'check_counted');
   assert.equal(check(raw,963,0,original).rc,1,'Original parser must reproduce exact ANSI counter defect');
  }
 }
 assert.match(current,/PROCESS_RC=\$\?[\s\S]*?RC=\$PROCESS_RC/);
 assert.equal((current.match(/process_exit=\$PROCESS_RC/g)??[]).length,2,'Both no-DB and DB phases must record original process exits');
 const phaseLines=current.split('\n').filter(line=>/^  echo "  (process_exit|exit)=/.test(line));
 assert.equal(phaseLines.length,4);
 const rendered=spawnSync('bash',['-c','PROCESS_RC=7;RC=1;NODB_SECS=1;SECS=2;DISK=0;\n'+phaseLines.join('\n')],{encoding:'utf8'});
 assert.equal(rendered.status,0);
 assert.equal([...rendered.stdout.matchAll(/^\s*exit=(\d+).*$/gm)].length,2,'Preserve existing phase parser exit= anchors');
 assert.equal([...rendered.stdout.matchAll(/^\s*process_exit=7$/gm)].length,2,'Record original process exit separately');

 console.log(JSON.stringify({kind:'PURE_COUNTER_REGRESSIONS_ONLY',checks,passed:true,rawLogIncluded:Boolean(process.argv[2]),originalRedIncluded:Boolean(process.argv[3]),applicationTestsRun:0,databaseCommands:0}));
}finally{rmSync(dir,{recursive:true,force:true});}
