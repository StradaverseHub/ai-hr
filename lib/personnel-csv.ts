/** Personnel's versioned, reversible CSV transport. Other CSV consumers keep their own semantics.
 * Keep the first row when editing a downloaded file. Protected text starts with '~p1~: keep that
 * prefix when editing the value. Existing unframed files never have apostrophes stripped. */
import type {PersonnelImportSheet} from './personnel-import-contract';
export const PERSONNEL_CSV_FRAME='AI-HR Personnel CSV';
export const PERSONNEL_CSV_VERSION='1';
export const PERSONNEL_CSV_CELL_PREFIX='~p1~';
const SHEETS:readonly PersonnelImportSheet[]=['employee','family','qualification','emergency'];
export class PersonnelCsvError extends Error {
 constructor(message:string){super(message);this.name='PersonnelCsvError';}
}
/** Strict RFC4180 syntax. Preserve embedded line endings; only record delimiters consume CRLF. */
function strictPersonnelCsvSource(text:string):{rows:string[][];rowNumbers:number[]} {
 const source=text.replace(/^\uFEFF/,''),rows:string[][]=[],rowNumbers:number[]=[];let recordNumber=1;let row:string[]=[],field='',state:'plain'|'quoted'|'closed'='plain';
 const fail=()=>{throw new PersonnelCsvError(`Malformed CSV near data row ${rows.length+1}. Close quoted cells and use doubled quotes inside them.`);};
 const endField=()=>{row.push(field);field='';state='plain';};
 const endRow=()=>{endField();if(row.some(value=>value!=='')){rows.push(row);rowNumbers.push(recordNumber);}recordNumber++;row=[];};
 for(let i=0;i<source.length;i++) {
  const c=source[i];
  if(state==='quoted') {
   if(c==='"'){if(source[i+1]==='"'){field+='"';i++;}else state='closed';}else field+=c;
   continue;
  }
  if(c===','){endField();continue;}
  if(c==='\r'||c==='\n'){endRow();if(c==='\r'&&source[i+1]==='\n')i++;continue;}
  if(state==='closed')fail();
  if(c==='"'){if(field!=='')fail();state='quoted';}else field+=c;
 }
 if(state==='quoted')fail();
 if(field!==''||row.length||state==='closed')endRow();
 return {rows,rowNumbers};
}
export function parseStrictPersonnelCsv(text:string):string[][] {return strictPersonnelCsvSource(text).rows;}
/** Logical CSV record positions, including empty records; quoted multiline cells stay one record. */
export function parseStrictPersonnelCsvWithSource(text:string){return strictPersonnelCsvSource(text);}
function protectedCell(value:string) {return /^[\s]*[=+\-@]/.test(value)||/^[\t\r\n']/.test(value);}
/** Neutral ~ prefix prevents spreadsheet formula interpretation without relying on Excel retaining
 * an initial apostrophe. Escape the prefix itself too; literal apostrophes stay inside this wrapper. */
export function encodePersonnelCsvCell(value:string):string {
 return protectedCell(value)||value.startsWith(PERSONNEL_CSV_CELL_PREFIX)?PERSONNEL_CSV_CELL_PREFIX+value:value;
}
function serialize(rows:readonly (readonly string[])[]) {
 const quote=(value:string)=>/[",\r\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value;
 return rows.map(row=>row.map(quote).join(',')).join('\r\n')+'\r\n';
}
export function buildPersonnelCsv(sheet:PersonnelImportSheet,rows:readonly (readonly (string|number|null|undefined)[])[]):string {
 if(!SHEETS.includes(sheet))throw new PersonnelCsvError('Unknown Personnel worksheet.');
 return serialize([[PERSONNEL_CSV_FRAME,PERSONNEL_CSV_VERSION,sheet,'Keep this first row. Protected text starts with ~p1~; keep its prefix when editing.'],
  ...rows.map(row=>row.map(value=>encodePersonnelCsvCell(value==null?'':String(value))))]);
}
export function parsePersonnelCsv(text:string,sheet:PersonnelImportSheet):string[][] {
 const rows=parseStrictPersonnelCsv(text);if(rows[0]?.[0]!==PERSONNEL_CSV_FRAME)return rows;
 const [frame,...data]=rows;
 if(frame[1]!==PERSONNEL_CSV_VERSION)throw new PersonnelCsvError('Unsupported Personnel CSV version. Download a new template.');
 if(!SHEETS.some(allowed=>allowed===sheet) || !SHEETS.some(allowed=>allowed===frame[2]) || frame[2]!==sheet)throw new PersonnelCsvError('This Personnel CSV belongs to another worksheet. Choose its matching import section.');
 if(frame.length>4)throw new PersonnelCsvError('Invalid Personnel CSV first row. Download a new template.');
 return data.map(row=>row.map(value=>value.startsWith(PERSONNEL_CSV_CELL_PREFIX)?value.slice(PERSONNEL_CSV_CELL_PREFIX.length):value));
}
