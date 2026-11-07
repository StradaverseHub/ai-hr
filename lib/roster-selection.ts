/** Explicit selection transport limits. Refuse excess input; never clip the reviewed target set. */
export const ROSTER_SELECTION_MAX=100_000;
export const ROSTER_SELECTION_MAX_BYTES=4_000_002;
export class RosterSelectionError extends Error{}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function parse(value:FormDataEntryValue|null,allowEmpty:boolean):string[]{
 if(value===null&&allowEmpty)return [];
 if(typeof value!=='string'||value.length>ROSTER_SELECTION_MAX_BYTES||new TextEncoder().encode(value).byteLength>ROSTER_SELECTION_MAX_BYTES)throw new RosterSelectionError('The roster selection is missing or too large. Prepare the selection again.');
 let rows:unknown;try{rows=JSON.parse(value);}catch{throw new RosterSelectionError('Invalid roster selection. Prepare the selection again.');}
 if(!Array.isArray(rows)||!allowEmpty&&!rows.length||rows.length>ROSTER_SELECTION_MAX||rows.some(id=>typeof id!=='string'||!uuid.test(id))||new Set(rows).size!==rows.length)throw new RosterSelectionError('Invalid roster selection. Choose between 1 and 100,000 distinct employees.');
 return rows;
}
/** Final admission always refuses empty or absent sets. */
export const parseRosterSelection=(value:FormDataEntryValue|null)=>parse(value,false);
/** Read-only browsing state only; cannot be used to admit a command. */
export const parseRosterDraftSelection=(value:FormDataEntryValue|null)=>parse(value,true);
