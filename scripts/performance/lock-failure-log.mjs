/** Retain lock topology and routine frames, never SQL, parameters or raw log lines.
 * @param {string} log */
export function postgresLockFailures(log){
 const failures=[];let current;
 for(const line of log.split('\n')){
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
