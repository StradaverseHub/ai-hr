/** Runs one bank import worker Python fixture with a private TMPDIR parent.
 *
 * The fixtures open their simulated server roots through the real ancestor fence (canonical_directory in
 * deploy/systemd/bank_import_worker_fences_v1.py). It correctly refuses when any ancestor directory changes
 * between its stat and its open. Under the shared /tmp, every temporary file another test creates changes /tmp
 * itself, so a busy full-gate test group could hit that window. The simulated cutover then stopped early with the
 * worker still running (the published-worker test failed in gates 45133716099, 45137133532, 45152559407 and
 * 45169731141; a CPU-load reproduction refused with "root ancestor changed while opening").
 *
 * Each fixture process therefore keeps its temporary roots under its own parent outside /tmp. Tests inside one
 * Python process run one after another, so nothing else writes into that parent while a fence is opening. */
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

export function runWorkerFixture(args:readonly string[],options:{timeout?:number}={}){
 const privateTmp=mkdtempSync(join(homedir(),'.aihr-worker-fixture-'));
 try{
  return spawnSync('python3',['-I','-B',...args],{encoding:'utf8',maxBuffer:1024**2,...options,env:{...process.env,TMPDIR:privateTmp}});
 }finally{rmSync(privateTmp,{recursive:true,force:true});}
}
