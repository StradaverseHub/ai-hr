const advisoryFamilies=new Set(['access-configuration','ai-control','audit-chain','employment','payroll-history','pay-component-catalog']);
const sourceRoutines=new Map([
 ['app.access_workforce_write_lock','workforce-policy-write'],
 ['app.access_profile_policy_read_lock','profile-policy-read'],
 ['app.access_profile_policy_write_lock','profile-policy-write'],
 ['app.ai_centre_assert_running','ai-centre-running'],
 ['app.ai_centre_control_lock','ai-centre-control'],
 ['app.ai_centre_mandate_write_order','ai-centre-mandate-order'],
 ['app.native_employee_draft_discard_delete','personnel-draft-delete'],
 ['app.assistant_generic_review_read','assistant-generic-review'],
 ['app.assistant_generic_reviews_index','assistant-generic-review-index'],
 ['app.assistant_legacy_reviews_index','assistant-legacy-review-index'],
 ['app.assistant_own_leave_reviews_expire_own','assistant-own-leave-expiry'],
]);
const waitSource=new Map([
 ...sourceRoutines,
 ['pg_advisory_xact_lock','direct-advisory-exclusive'],
 ['pg_advisory_xact_lock_shared','direct-advisory-shared'],
]);

/** @typedef {{runtimeFrom?:string,bracketed?:boolean,advisoryKeys?:Map<string,string>}} LockDiagnosticsOptions */
function lockPhase(line,options){
 if(options.bracketed)return 'qualified-runtime';
 const timestamp=line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) (UTC|Z|[+-]\d{2}(?::?\d{2})?) /);
 if(!timestamp||!options.runtimeFrom)return 'unknown';
 const offset=timestamp[3]==='UTC'?'Z':timestamp[3].length===3?timestamp[3]+':00':timestamp[3];
 const time=Date.parse(timestamp[1]+'T'+timestamp[2]+offset),runtime=Date.parse(options.runtimeFrom);
 return !Number.isFinite(time)||!Number.isFinite(runtime)?'unknown':time<runtime?'before-runtime-start':'after-runtime-start';
}

function lockFamily(lock,keys){
 const advisory=lock.match(/^advisory lock \[(\d+), ?(\d+), ?(\d+), ?([12])\]$/);
 if(advisory){
  const family=keys?.get(advisory.slice(1).join(':'));
  return advisoryFamilies.has(family)?family:'advisory-unclassified';
 }
 return lock.startsWith('advisory lock ')?'advisory-unclassified':lock.split(' ',1)[0];
}

function diagnostic(failure,observation,keys){
 const participants=new Map(),resources=new Map();
 function ordinal(map,value){if(!map.has(value))map.set(value,map.size+1);return map.get(value);}
 const edges=failure.waits.slice(0,8).map(wait=>({
  waiter:ordinal(participants,wait.pid),blocker:ordinal(participants,wait.blockedBy),resource:ordinal(resources,wait.lock),
  mode:wait.mode,family:lockFamily(wait.lock,keys),waiterCall:observation.calls.get(wait.pid)??null,
  blockerCall:observation.calls.get(wait.blockedBy)??null,
 }));
 const victimRoutines=[...new Set(failure.routines.map(frame=>sourceRoutines.get(frame.function.split('(',1)[0])).filter(Boolean))].slice(0,6);
 return {phase:observation.phase,edges,allParsedEdgesRetained:failure.waits.length<=8,victimRoutines};
}

/** Retain lock topology and routine frames, never SQL, parameters or raw log lines.
 * @param {string} log
 * @param {LockDiagnosticsOptions} [options] */
export function postgresLockFailures(log,options){
 const failures=[],observations=new Map();let current;
 const retain=(failure,line)=>{
  failures.push(failure);
  if(options)observations.set(failure,{phase:lockPhase(line,options),calls:new Map()});
 };
 for(const line of log.split('\n')){
  // PostgreSQL logs these only after the lock-wait timer fired. An acquired
  // message still witnesses blocking, even if no timeout reached the user.
  const prefix=line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [A-Z0-9+-]+ \[(\d{1,10})\] (?:[0-9a-f]{1,16}\.([0-9a-f]{1,8}) )?(?:(?:[a-z0-9_]{0,64}|\[unknown\])@(?:[a-z0-9_]{0,64}|\[unknown\]) )?LOG:\s+/);
  const waited=prefix&&line.slice(prefix[0].length).match(/^process (\d{1,10}) (still waiting for|acquired|avoided deadlock for|detected deadlock while waiting for|failed to acquire) (AccessShareLock|RowShareLock|RowExclusiveLock|ShareUpdateExclusiveLock|ShareLock|ShareRowExclusiveLock|ExclusiveLock|AccessExclusiveLock) on [^\r\n]{1,512} after (\d{1,12}\.\d{3}) ms\s*$/);
  const pid=prefix?Number(prefix[1]):0;
  if(waited&&pid>0&&pid===Number(waited[1])&&(prefix[2]===undefined||pid===Number.parseInt(prefix[2],16))){
   current=undefined;
   if(failures.length<64)retain({kind:'observed heavyweight lock wait',pid,
    outcome:waited[2],mode:waited[3],waitMs:Number(waited[4]),waits:[],routines:[]},line);
   continue;
  }
  const error=line.match(/\bERROR:\s+(deadlock detected|canceling statement due to lock timeout)\s*$/);
  if(error){
   if(failures.length>=64){current=undefined;continue;}
   current={kind:error[1],pid:Number(line.match(/\[(\d+)\]/)?.[1]??0),waits:[],routines:[]};retain(current,line);continue;
  }
  if(!current)continue;
  if(options){
   const source=line.match(/^\s*Process (\d{1,10}):\s*select\s+(?:\*\s+from\s+)?(pg_advisory_xact_lock(?:_shared)?|app\.[a-z_]+)\s*\(/i);
   const routine=source&&waitSource.get(source[2].toLowerCase()),calls=observations.get(current).calls;
   if(routine&&calls.size<16)calls.set(Number(source[1]),routine);
  }
  if(/\b(?:ERROR|STATEMENT):/.test(line)){current=undefined;continue;}
  const wait=line.match(/(?:DETAIL:\s+|^\s*)Process (\d+) waits for ([A-Za-z]+) on (transaction \d+|relation \d+ of database \d+|advisory lock \[[0-9, ]+\]|tuple \(\d+,\d+\) of relation \d+ of database \d+); blocked by process (\d+)\.\s*$/);
  if(wait&&current.waits.length<64)current.waits.push({pid:Number(wait[1]),mode:wait[2],lock:wait[3],blockedBy:Number(wait[4])});
  const routine=line.match(/\bPL\/pgSQL function ([A-Za-z_][A-Za-z0-9_.]*\([A-Za-z0-9_.,\[\] ]*\)) line (\d+) at (SQL statement|PERFORM|RAISE|assignment|RETURN)\s*$/);
  if(routine&&current.routines.length<32)current.routines.push({function:routine[1],line:Number(routine[2]),operation:routine[3]});
 }
 return options?failures.map(row=>({...row,diagnostic:diagnostic(row,observations.get(row),options.advisoryKeys)})):failures;
}

/** Bound the disposable-server log by settings-checked, same-birth markers.
 * @param {string} log
 * @param {string|null} nonce
 * @param {LockDiagnosticsOptions} [options] */
export function developmentPostgresLockWindow(log,nonce,options){
 if(typeof log!=='string'||typeof nonce!=='string'||!/^[a-f0-9]{32}$/.test(nonce))return null;
 const lines=log.split('\n');
 const markers=[];
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  if(!line.includes('AIHR_LOCK_WINDOW_V1 '+nonce+' '))continue;
  const marker=line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [A-Z0-9+-]+ \[([1-9]\d{0,9})\] [0-9a-f]{1,16}\.([0-9a-f]{1,8}) postgres@ai_hr_dev LOG:\s+AIHR_LOCK_WINDOW_V1 ([a-f0-9]{32}) (begin|end)$/);
  if(!marker||marker[3]!==nonce||Number(marker[1])!==Number.parseInt(marker[2],16))return null;
  markers.push({index,phase:marker[4]});
 }
 if(markers.length!==2||markers[0].phase!=='begin'||markers[1].phase!=='end')return null;
 return {thresholdMs:100,failures:postgresLockFailures(lines.slice(markers[0].index+1,markers[1].index).join('\n'),options?{...options,bracketed:true}:undefined)};
}
