/** Explicit selection transport limits. Refuse excess input; never clip the reviewed target set. */
export const ROSTER_SELECTION_MAX=100_000;
export const ROSTER_SELECTION_MAX_BYTES=4_000_002;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function parseRosterSelection(value:FormDataEntryValue|null):string[]{
 if(typeof value!=='string'||new TextEncoder().encode(value).byteLength>ROSTER_SELECTION_MAX_BYTES)throw new Error('The roster selection is missing or too large. Prepare the selection again.');
 let rows:unknown;try{rows=JSON.parse(value);}catch{throw new Error('Invalid roster selection. Prepare the selection again.');}
 if(!Array.isArray(rows)||!rows.length||rows.length>ROSTER_SELECTION_MAX||rows.some(id=>typeof id!=='string'||!uuid.test(id))||new Set(rows).size!==rows.length)throw new Error('Invalid roster selection. Choose between 1 and 100,000 distinct employees.');
 return rows;
}
