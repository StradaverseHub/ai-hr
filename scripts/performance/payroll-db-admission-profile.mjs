// Loaded only by the synthetic Payroll action benchmark. Existing database timing
// hooks report intervals without SQL, parameters, job identities or tenant identities.
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

const phases=['session','translations','prechecks','enqueue'];
const context=new AsyncLocalStorage();

if(process.env.GITHUB_ACTIONS==='true'&&process.env.AIHR_PAYROLL_RECEIPT_PROFILE==='true'){
 globalThis.__aihrPerfPayrollAdmission=measure=>{
  const probe={phase:0,database:{}};
  return context.run(probe,()=>measure({
   markComplete(phase){if(phase===phases[probe.phase])probe.phase++;},
   snapshot(){
    return Object.fromEntries(Object.entries(probe.database).map(([phase,kinds])=>[
     phase,Object.fromEntries(Object.entries(kinds).map(([kind,row])=>[
      kind,{...row,startDelayMs:Math.round(row.startDelayMs),afterStartMs:Math.round(row.afterStartMs)},
     ])),
    ]));
   },
  }));
 };
 globalThis.__aihrPerfBeginPoolWork=()=>measureDatabase('raw');
 globalThis.__aihrPerfBeginTransaction=()=>measureDatabase('transaction');
}

function measureDatabase(kind){
 const probe=context.getStore(),phase=phases[probe?.phase];
 if(!phase)return;
 const phaseTimings=probe.database[phase]??={};
 const row=phaseTimings[kind]??={started:0,acquired:0,completed:0,startDelayMs:0,afterStartMs:0};
 const started=performance.now();
 let acquired;
 row.started++;
 return {
  acquired(){
   acquired=performance.now();
   row.acquired++;
   row.startDelayMs+=acquired-started;
  },
  finished(){
   if(acquired===undefined)return;
   row.completed++;
   row.afterStartMs+=performance.now()-acquired;
  },
 };
}
