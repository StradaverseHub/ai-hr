/** Execute only the actual EXIT cleanup function with fake sudo/awk; no compiler, swap or kernel mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const text=readFileSync(new URL('../typecheck.sh',import.meta.url),'utf8');
const start=text.indexOf('cleanup() {'),end=text.indexOf('\ntrap cleanup EXIT',start);
assert(start>=0&&end>start,'Exact nonempty cleanup function boundary required');
const cleanup=text.slice(start,end);
assert(cleanup.length>100&&cleanup.endsWith('\n}'),'Unexpected cleanup function extraction');

function run({original=0,swapoffFails=false,observationFails=false,owned=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'aihr-compiler-cleanup-'));
 try{
  const swapfile=join(dir,'owned-zero-byte-fixture.swap');writeFileSync(swapfile,'',{flag:'wx'});
  const shell=String.raw`
set -euo pipefail
compiler_mode=--state-transport-producer
swapfile="$RUNNER_TEMP/owned-zero-byte-fixture.swap"
owned_swap="$MOCK_OWNED"
owned_file="$MOCK_OWNED"
simulated_active="$MOCK_OWNED"
sudo() {
 case "$1" in
  swapoff)
   [[ "$#" == 2 && "$2" == "$swapfile" ]] || exit 97
   if [[ "$MOCK_SWAPOFF_FAILS" == 1 ]]; then return 1; fi
   simulated_active=0 ;;
  rm)
   [[ "$#" == 4 && "$2" == -f && "$3" == -- && "$4" == "$swapfile" && "$MOCK_OWNED" == 1 ]] || exit 99
   command rm -f -- "$swapfile" ;;
  *) exit 96 ;;
 esac
}
awk() {
 [[ "$#" == 4 && "$1" == -v && "$2" == "path=$swapfile" && "$4" == /proc/swaps ]] || exit 95
 if [[ "$MOCK_OBSERVATION_FAILS" == 1 ]]; then return 2; fi
 printf '%s\n' "$simulated_active"
}
`+cleanup+String.raw`
trap cleanup EXIT
exit "$MOCK_ORIGINAL"
`;
  const result=spawnSync('bash',['-c',shell],{encoding:'utf8',timeout:5000,
   env:{...process.env,RUNNER_TEMP:dir,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',MOCK_OWNED:owned?'1':'0',
    MOCK_SWAPOFF_FAILS:swapoffFails?'1':'0',MOCK_OBSERVATION_FAILS:observationFails?'1':'0',MOCK_ORIGINAL:String(original)}});
  assert.equal(result.signal,null);assert.equal(result.error,undefined);
  const report=JSON.parse(readFileSync(join(dir,'compiler-transport-swap-cleanup.json'),'utf8'));
  return {result,report,fileExists:existsSync(swapfile)};
 }finally{rmSync(dir,{recursive:true});}
}
test('actual prototype cleanup removes only stopped owned fake swap and retains successful compiler exit',()=>{
 const {result,report,fileExists}=run();assert.equal(result.status,0,result.stderr);
 assert.equal(fileExists,false);assert.equal(report.kind,'OWNED_COMPILER_SWAP_CLEANUP');
 assert.equal(report.originalCommandExit,0);assert.equal(report.cleanupExit,0);
 assert.equal(report.swapAbsent,true);assert.equal(report.fileAbsent,true);
});
test('actual compiler diagnostic exit survives successful owned cleanup',()=>{
 const {result,report,fileExists}=run({original:2});assert.equal(result.status,2,result.stderr);
 assert.equal(report.originalCommandExit,2);assert.equal(report.cleanupExit,0);assert.equal(fileExists,false);
});
test('failed fake swapoff fails the job and never unlinks an active swap file',()=>{
 const {result,report,fileExists}=run({swapoffFails:true});assert.equal(result.status,1,result.stderr);
 assert.equal(report.cleanupExit,1);assert.equal(report.swapAbsent,false);assert.equal(report.fileAbsent,false);assert.equal(fileExists,true);
});
test('failed swap observation fails closed and never unlinks an unobserved file',()=>{
 const {result,report,fileExists}=run({observationFails:true});assert.equal(result.status,1,result.stderr);
 assert.equal(report.cleanupExit,1);assert.equal(report.swapAbsent,false);assert.equal(fileExists,true);
});
test('unowned existing fake file is never removed',()=>{
 const {result,report,fileExists}=run({owned:false});assert.equal(result.status,1,result.stderr);
 assert.equal(report.ownedSwap,0);assert.equal(report.ownedFile,0);assert.equal(report.fileAbsent,false);assert.equal(fileExists,true);
});
