const limits=[1,5,10,50,100,500,1000,5000,10000,30000,90000,Infinity];
/** @param {()=>number} [clock] */
export function createTransactionTimingCollector(clock=Date.now){
 const windows=new Map(),gauges={tenant:{waiting:0,active:0,settling:0},entitlements:{waiting:0,active:0,settling:0}};
 /** @param {{scope:'tenant'|'entitlements',phase:'start'|'entered'|'left'|'finished',durationMs?:number,entered?:boolean,failed?:boolean}} event */
 function record(event){
  const gauge=gauges[event.scope];if(!gauge)return;
  const at=Math.floor(clock()/10000)*10000,key=at+':'+event.scope;
  let row=windows.get(key);if(!row){row={at,scope:event.scope,events:{},timings:{},peakWaiting:gauge.waiting,peakActive:gauge.active,peakSettling:gauge.settling,failed:0};windows.set(key,row);}
  row.events[event.phase]=(row.events[event.phase]??0)+1;
  if(event.phase==='start')gauge.waiting++;
  if(event.phase==='entered'){gauge.waiting--;gauge.active++;}
  if(event.phase==='left'){gauge.active--;gauge.settling++;}
  if(event.phase==='finished'){if(event.entered)gauge.settling--;else gauge.waiting--;if(event.failed)row.failed++;}
  row.peakWaiting=Math.max(row.peakWaiting,gauge.waiting);row.peakActive=Math.max(row.peakActive,gauge.active);row.peakSettling=Math.max(row.peakSettling,gauge.settling);
  if(event.durationMs!==undefined){
   const phase=event.phase==='finished'&&!event.entered?'refusedBeforeEntry':event.phase;
   const metric=row.timings[phase]??={count:0,totalMs:0,maxMs:0,buckets:limits.map(()=>0)};
   metric.count++;metric.totalMs+=event.durationMs;metric.maxMs=Math.max(metric.maxMs,event.durationMs);
   metric.buckets[limits.findIndex(limit=>event.durationMs<=limit)]++;
  }
 }
 return {record,snapshot:()=>({kind:'ISOLATED_TRANSACTION_ENVELOPES',note:'entered includes pool admission and BEGIN; left includes SQL, locks, JS and network inside callback; finished after left includes COMMIT/ROLLBACK. Not pure SQL service or exact pool wait. Failed-before-entry duration is separate.',bucketUpperMs:limits.map(x=>Number.isFinite(x)?x:null),gauges,windows:[...windows.values()]})};
}
