import {sql,type SQL,type SQLWrapper} from 'drizzle-orm';

/** Statement size, never a target/cell limit. All chunks retain the caller's transaction. */
export const ROSTER_WRITE_ROWS_PER_STATEMENT=1000;

/** One bound UUID array avoids the protocol's 65,535-parameter limit. Quote every
 * array element, escaping backslashes before quotes; caller text cannot add an
 * array member. PostgreSQL still parses EVERY member as UUID at Bind, including
 * when the outer population is empty, and retains its accepted UUID spellings. */
export function rosterUuidSet(column:SQLWrapper,ids:readonly string[]):SQL {
 const encoded='{'+ids.map(id=>'"'+id.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"').join(',')+'}';
 return sql`${column}=any(${encoded}::uuid[])`;
}

/** A single ON CONFLICT statement refuses repeated physical employee/date keys.
 * Chunking must not turn that refusal into a last-chunk-wins update. */
export function assertUniqueRosterWriteKeys(rows:readonly {employmentId:string;shiftDate:string}[]):void {
 const seen=new Set<string>();
 for(const row of rows){
  // The original guards have already parsed these UUIDs in PostgreSQL. Its
  // accepted upper-case/braced/nonhyphenated spellings name the same row.
  const key=row.employmentId.replace(/[{}-]/g,'').toLowerCase()+'\0'+row.shiftDate;
  if(seen.has(key)){
   const error=new Error('Each employee and roster date must appear once.');
   // Retain the original PostgreSQL cardinality-violation classification without
   // exposing SQL or IDs. The caller still rolls back the complete transaction.
   Object.assign(error,{code:'21000'});throw error;
  }
  seen.add(key);
 }
}
