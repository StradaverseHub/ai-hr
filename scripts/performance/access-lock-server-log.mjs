// Only aggregate wait events for the benchmark's Access keys. Keep raw log text private.
const routines=new Set([
 'consume_invitation','manual_identity_link','entra_auto_bind',
 'access_profile_access_generation','access_profile_setting_generation',
 '_assistant_own_leave_review_identity','assistant_own_leave_review_subject',
 'assistant_own_leave_review_read','assistant_generic_review_subject',
 'assistant_generic_review_read','_assistant_leave_decision_login',
 'reward_config_create_planned_unit','reward_review_plan_save','access_workforce_write_lock',
]);

const prefix=/^(\S+) .*?\[(\d+)\]\s+(LOG|ERROR|DETAIL|CONTEXT|STATEMENT|HINT):\s*(.*)$/;
const advisory=/^process (\d+) (still waiting for|acquired) (ShareLock|ExclusiveLock) on advisory lock \[([^\]]+)\] after (\d+(?:\.\d+)?) ms$/;
const functionFrame=/\b(?:PL\/pgSQL|SQL) function (?:app\.)?([a-z_][a-z_0-9]*)\(/gi;
const directCall=/^select\s+pg_advisory_xact_lock(?:_shared)?\s*\(/i;

export function summarizeAccessLockLog(streams,keys,fromMs,toMs){
 const accessKeys=new Set(keys);
 const groups=new Map();
 let matched=0;
 for(const stream of streams){
  const events=[];
  let active;
  for(const line of stream.split('\n')){
   const fields=prefix.exec(line);
   if(!fields){
    if(active?.continuation&&/^\S+\s+\t/.test(line)){
     active.frames.push(...Array.from(line.matchAll(functionFrame),match=>match[1]));
    }else if(active)active.continuation=false;
    continue;
   }
   const [,timestamp,pid,kind,message]=fields;
   const at=Date.parse(timestamp);
   if(!Number.isFinite(at)||at<fromMs||at>toMs){active=undefined;continue;}
   if(kind==='LOG'){
    const event=advisory.exec(message);
    if(event?.[1]===pid&&accessKeys.has(event[4].replace(/\s/g,''))){
     const [, ,verb,mode,,elapsed]=event;
     active={pid,event:verb==='acquired'?'acquired':'still-waiting',mode,elapsed:Number(elapsed),frames:[],direct:false};
     events.push(active);
    }else active=undefined;
   }else if(active?.pid!==pid||kind==='ERROR')active=undefined;
   else if(kind==='CONTEXT'){
    active.frames.push(...Array.from(message.matchAll(functionFrame),match=>match[1]));
    active.continuation=true;
   }else{
    active.continuation=false;
    if(kind==='STATEMENT')active.direct=directCall.test(message);
   }
  }
  for(const event of events){
   const routine=event.frames.find(frame=>routines.has(frame));
   const source=routine??(event.frames.length?'other-database-routine':event.direct?'direct-advisory-call':'unresolved');
   const key=JSON.stringify([event.mode,event.event,source]);
   const group=groups.get(key)??{mode:event.mode,event:event.event,source,count:0,maxWaitMs:0};
   group.count++;
   group.maxWaitMs=Math.max(group.maxWaitMs,Math.round(event.elapsed));
   groups.set(key,group);
   matched++;
  }
 }
 return {matched,groups:[...groups.values()].sort((left,right)=>right.count-left.count)};
}
