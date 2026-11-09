/** Retain lock topology and routine frames, never SQL, parameters or raw log lines.
 * @param {string} log */
export function postgresLockFailures(log){
 const failures=[];let current;
 for(const line of log.split('\n')){
  // PostgreSQL logs these only after the lock-wait timer fired. An acquired
  // message still witnesses blocking, even if no timeout reached the user.
  const prefix=line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [A-Z0-9+-]+ \[(\d{1,10})\] (?:[0-9a-f]{1,16}\.([0-9a-f]{1,8}) )?(?:(?:[a-z0-9_]{0,64}|\[unknown\])@(?:[a-z0-9_]{0,64}|\[unknown\]) )?LOG:\s+/);
  const waited=prefix&&line.slice(prefix[0].length).match(/^process (\d{1,10}) (still waiting for|acquired|avoided deadlock for|detected deadlock while waiting for|failed to acquire) (AccessShareLock|RowShareLock|RowExclusiveLock|ShareUpdateExclusiveLock|ShareLock|ShareRowExclusiveLock|ExclusiveLock|AccessExclusiveLock) on [^\r\n]{1,512} after (\d{1,12}\.\d{3}) ms\s*$/);
  const pid=prefix?Number(prefix[1]):0;
  if(waited&&pid>0&&pid===Number(waited[1])&&(prefix[2]===undefined||pid===Number.parseInt(prefix[2],16))){
   current=undefined;
   if(failures.length<64)failures.push({kind:'observed heavyweight lock wait',pid,
    outcome:waited[2],mode:waited[3],waitMs:Number(waited[4]),waits:[],routines:[]});
   continue;
  }
  const error=line.match(/\bERROR:\s+(deadlock detected|canceling statement due to lock timeout)\s*$/);
  if(error){
   if(failures.length>=64){current=undefined;continue;}
   current={kind:error[1],pid:Number(line.match(/\[(\d+)\]/)?.[1]??0),waits:[],routines:[]};failures.push(current);continue;
  }
  if(!current)continue;
  if(/\b(?:ERROR|STATEMENT):/.test(line)){current=undefined;continue;}
  const wait=line.match(/(?:DETAIL:\s+|^\s*)Process (\d+) waits for ([A-Za-z]+) on (transaction \d+|relation \d+ of database \d+|advisory lock \[[0-9, ]+\]|tuple \(\d+,\d+\) of relation \d+ of database \d+); blocked by process (\d+)\.\s*$/);
  if(wait&&current.waits.length<64)current.waits.push({pid:Number(wait[1]),mode:wait[2],lock:wait[3],blockedBy:Number(wait[4])});
  const routine=line.match(/\bPL\/pgSQL function ([A-Za-z_][A-Za-z0-9_.]*\([A-Za-z0-9_.,\[\] ]*\)) line (\d+) at (SQL statement|PERFORM|RAISE|assignment|RETURN)\s*$/);
  if(routine&&current.routines.length<32)current.routines.push({function:routine[1],line:Number(routine[2]),operation:routine[3]});
 }
 return failures;
}

/** Bound the disposable-server log by settings-checked, same-birth markers.
 * @param {string} log
 * @param {string|null} nonce */
export function developmentPostgresLockWindow(log,nonce){
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
 return {thresholdMs:100,failures:postgresLockFailures(lines.slice(markers[0].index+1,markers[1].index).join('\n'))};
}
