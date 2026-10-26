/** Inclusive phase measurements are not summed across overlapping workers or nested setup phases. */
import {readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
const [directory,destination]=process.argv.slice(2);
if(!directory||!destination)throw Error('Usage: report-test-profile.mjs <profile-directory> <summary.json>');
const names=readdirSync(directory).filter(f=>/^profile-\d+-[A-Za-z0-9_-]+\.jsonl$/.test(f));
if(!names.length||names.length>10000)throw Error('Missing or excessive timing evidence');
const phases=new Map(),heads=new Set();let bytes=0;
for(const name of names){
 const path=join(directory,name),size=statSync(path).size;bytes+=size;if(size>16*1024**2||bytes>64*1024**2)throw Error('Timing evidence exceeds bound');
 for(const line of readFileSync(path,'utf8').trim().split('\n')){
  if(line.length>4096)throw Error('Oversized timing row');const r=JSON.parse(line);
  if(r.schemaVersion!==1||!['reset','seed','close','template-setup','template-migrate','worker-clone'].includes(r.phase)
   ||!['passed','failed'].includes(r.status)||!Number.isFinite(r.durationMs)||r.durationMs<0
   ||!/^[a-f0-9]{40}$/.test(r.candidate??'')||r.candidate!==process.env.AIHR_CI_HEAD)throw Error('Invalid or foreign timing row');
  heads.add(r.candidate);const rows=phases.get(r.phase)??[];rows.push(r);phases.set(r.phase,rows);
 }
}
const summary={kind:'INCLUSIVE_TEST_PHASE_TIMING_NOT_RELEASE_EVIDENCE',candidate:[...heads][0],files:names.length,phases:{},note:'Phase totals overlap across workers; template-setup includes migration and cloning. These are not end-to-end wall time.'};
for(const [phase,rows] of phases){const times=rows.map(r=>r.durationMs).sort((a,b)=>a-b);const total=times.reduce((a,b)=>a+b,0);summary.phases[phase]={calls:rows.length,failed:rows.filter(r=>r.status==='failed').length,totalMs:total,meanMs:total/rows.length,minMs:times[0],medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.ceil(times.length*.95)-1],maxMs:times.at(-1)};}
writeFileSync(destination,JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(summary));
