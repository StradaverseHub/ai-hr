/** Retain lock topology and routine frames, never SQL, parameters or raw log lines.
 * @param {string} log */
export function postgresLockFailures(log){
 const failures=[];let current;
 for(const line of log.split('\n')){
  // PostgreSQL logs these only after the lock-wait timer fired. An acquired
  // message still witnesses blocking, even if no timeout reached the user.
  const waited=line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [A-Z0-9+-]+ \[(\d{1,10})\] (?:[a-z0-9_]+@[a-z0-9_]+ )?LOG:\s+process (\d{1,10}) (still waiting for|acquired|avoided deadlock for|detected deadlock while waiting for|failed to acquire) (AccessShareLock|RowShareLock|RowExclusiveLock|ShareUpdateExclusiveLock|ShareLock|ShareRowExclusiveLock|ExclusiveLock|AccessExclusiveLock) on [^\r\n]{1,512} after (\d{1,12}\.\d{3}) ms\s*$/);
  if(waited&&waited[1]===waited[2]&&Number(waited[1])>0){
   current=undefined;
   if(failures.length<64)failures.push({kind:'observed heavyweight lock wait',pid:Number(waited[1]),
    outcome:waited[3],mode:waited[4],waitMs:Number(waited[5]),waits:[],routines:[]});
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
