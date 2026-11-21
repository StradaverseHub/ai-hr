/**
 * Bounded-memory Bank & Statutory decoder for the durable worker's first ('queued') tick. Never a response deadline.
 *
 * It produces exactly what decodeBankImportSource (lib/bank-import-source.server.ts, kept byte-identical for the
 * archived-worker overlap proof) produces: the same records in the same order, the same duplicate-row errors, the same
 * thrown error for every refused file and the same limits. test/bank-import-stream-source.test.ts compares the two.
 * What changes is where the memory goes (measured 14 Nov 2026: about 3.8 GB for a 118.6 MiB CSV and 3.1 GB for a
 * 29.7 MiB workbook, on a 3.9 GB host shared with PostgreSQL):
 *
 * - CSV is UTF-8 decoded part by part from the stored 1 MiB upload parts (each released once read) and parsed by an
 *   incremental copy of the strict Personnel CSV grammar. No whole-file text, row array or record-object array is built,
 *   and fields are sliced from the decoded part instead of grown one character at a time.
 * - Excel still goes through SheetJS, the one workbook cell decoder, with options that drop only presentation fields
 *   (formatted text `w`, rich-text HTML `h`) and store cells densely. The first sheet is read in row windows straight
 *   into the record builder, with the original whole-sheet CSV text and its second parse reproduced arithmetically
 *   (byte size, blank-row rule, leading byte-order mark and cell budgets) instead of materialized.
 * - Records are staged as UTF-8 JSON value arrays, BANK_IMPORT_STAGE_ROWS per batch, outside the JS heap: one batch
 *   per insert statement of the unchanged single staging transaction.
 */
import {ImportFileError,importFileFormat} from './import-file';
import {BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS} from './bank-import-job';
import {PersonnelImportHeaderError,personnelColumnLabel,personnelFieldChoices,personnelImportField,personnelImportHeaderCandidates,normalizePersonnelImportValue} from './personnel-import-contract';
import {PERSONNEL_CSV_CELL_PREFIX,PERSONNEL_CSV_FRAME,PERSONNEL_CSV_VERSION,PersonnelCsvError} from './personnel-csv';
import {personnelImportLabelResolvers} from './personnel-import-labels.runtime';
import {sectionParseColumns} from './import-sections';
import {normalizeEmployeeCode} from './employee-code';
import {numberToPlainString,toIsoDate} from './spreadsheet';

/** Rows per staged batch and per insert statement (the worker's existing 1,000-row insert slices). */
export const BANK_IMPORT_STAGE_ROWS=1000;
export type BankImportStaged={total:number;headers:string[];warnings:string[];errors:Map<number,string>;batches:Buffer[]};

// The same arguments decodeBankImportSource passes to readImportFile and parsePersonnelImportCsv.
const ROW_LIMIT=BANK_IMPORT_MAX_ROWS+2;
const MAX_CELLS=20_000_000;
const ALLOWED_SHEETS=['Reference','Instructions','__PersonnelLists'];
// Strict Personnel CSV limits and messages (lib/personnel-csv.ts, strictPersonnelCsvSource with a row limit).
const FIELD_CHARS=1048576,ROW_FIELDS=256,CSV_CELLS=20_000_000;
const budgetError=()=>new PersonnelCsvError('The file exceeds the import row, column or cell size limit.');
const malformedError=(rows:number)=>new PersonnelCsvError(`Malformed CSV near data row ${rows+1}. Close quoted cells and use doubled quotes inside them.`);
const SHEET_WINDOW_ROWS=5000;

/**
 * parsePersonnelImportCsv (Personnel frame, headings, normalization) and decodeBankImportSource (row count and
 * whole-file duplicate checks), applied one parsed CSV row at a time. The first content error is kept, not thrown,
 * because a later CSV syntax or budget error takes precedence in the whole-file original.
 */
class BankRecordStage{
 private seen=0;private framed=false;private headers:string[]|null=null;private warnings:string[]=[];
 private total=0;private deferred:unknown=null;private stored=true;
 private codeIndex=-1;private cardIndex=-1;
 private codes=new Map<string,number>();private cards=new Map<string,number[]>();private errors=new Map<number,string>();
 private pending:string[]=[];private batches:Buffer[]=[];
 private normalizers:((raw:string)=>string)[]=[];
 add(row:string[]){
  if(this.deferred!==null)return;
  try{this.accept(row);}catch(error){this.deferred=error;this.release();}
 }
 /** A higher-precedence error was found; nothing staged can be used. */
 release(){this.stored=false;this.pending=[];this.batches=[];this.codes.clear();this.cards.clear();this.errors.clear();}
 private accept(input:string[]){
  if(this.seen++===0&&input[0]===PERSONNEL_CSV_FRAME){
   // decodePersonnelCsvRows, for sheet 'employee'.
   if(input[1]!==PERSONNEL_CSV_VERSION)throw new PersonnelCsvError('Unsupported Personnel CSV version. Download a new template.');
   if(input[2]!=='employee')throw new PersonnelCsvError('This Personnel CSV belongs to another worksheet. Choose its matching import section.');
   if(input.length>4)throw new PersonnelCsvError('Invalid Personnel CSV first row. Download a new template.');
   this.framed=true;return;
  }
  const row=this.framed?input.map(value=>value.startsWith(PERSONNEL_CSV_CELL_PREFIX)?value.slice(PERSONNEL_CSV_CELL_PREFIX.length):value):input;
  if(!this.headers){this.resolveHeaders(row);return;}
  const headers=this.headers,index=this.total;
  if(row.length>headers.length&&row.slice(headers.length).some(cell=>cell.trim()))throw new PersonnelImportHeaderError(`Row ${index+2} has values beyond its column headings.`);
  const values=headers.map((_,i)=>this.normalizers[i]((row[i]??'').trim()));
  const ordinal=++this.total;
  if(this.total>BANK_IMPORT_MAX_ROWS){if(this.stored)this.release();return;}
  const code=normalizeEmployeeCode(this.codeIndex<0?undefined:values[this.codeIndex]),prior=this.codes.get(code);
  if(code){if(prior!==undefined)this.errors.set(ordinal,`Duplicate Employee ID in this file; first used at row ${prior}.`);else this.codes.set(code,ordinal);}
  const card=(this.cardIndex<0?undefined:values[this.cardIndex])?.trim().toLowerCase();
  if(card){const group=this.cards.get(card)??[];group.push(ordinal);this.cards.set(card,group);}
  this.pending.push(JSON.stringify(values));
  if(this.pending.length===BANK_IMPORT_STAGE_ROWS)this.flush();
 }
 private flush(){if(this.pending.length){this.batches.push(Buffer.from('['+this.pending.join(',')+']','utf8'));this.pending=[];}}
 private resolveHeaders(row:string[]){
  const columns=sectionParseColumns('bank_statutory'),seen=new Set<string>();
  const candidates=personnelImportHeaderCandidates(row,{columns,sheet:'employee',rowLimit:ROW_LIMIT,resolvers:personnelImportLabelResolvers});
  const headers=candidates.map(({raw,matches,current})=>{
   if(matches.length!==1)throw new PersonnelImportHeaderError(matches.length ? `Ambiguous column “${raw}”. Download the current template and use its complete heading.` : `Unrecognized or removed column “${raw}”. Download the current template; this column cannot be applied.`);
   const column=matches[0];
   if(seen.has(column))throw new PersonnelImportHeaderError(`Column “${raw}” repeats “${personnelColumnLabel(column,'employee')}”. Keep one column; old and new headings cannot appear together.`);
   seen.add(column);
   if(!current)this.warnings.push(`Older header “${raw}”: use “${personnelColumnLabel(column,'employee')}” in the next template generation.`);
   return column;
  });
  this.headers=headers;this.codeIndex=headers.indexOf('employee_code');this.cardIndex=headers.indexOf('card_id');
  // normalizePersonnelImportValue returns its input for a blank value, an unknown column or a column without
  // choices; it is pure, so a choice column's results are memoized per distinct value.
  this.normalizers=headers.map(header=>{
   const field=personnelImportField(header,'employee');
   if(!field||!personnelFieldChoices(field).length)return(raw:string)=>raw;
   const memo=new Map<string,string>();
   return(raw:string)=>{
    if(!raw)return raw;
    const known=memo.get(raw);if(known!==undefined)return known;
    const value=normalizePersonnelImportValue(header,raw,'employee',personnelImportLabelResolvers);
    if(memo.size<4096)memo.set(raw,value);
    return value;
   };
  });
 }
 finish():BankImportStaged{
  if(this.deferred!==null)throw this.deferred;
  if(!this.total||this.total>BANK_IMPORT_MAX_ROWS)throw new Error('Choose a file with 1 to 250,000 data rows.');
  this.flush();
  for(const group of this.cards.values())if(group.length>1)for(const row of group)this.errors.set(row,'Duplicate Card ID in this file.');
  return{total:this.total,headers:this.headers!,warnings:this.warnings,errors:this.errors,batches:this.batches};
 }
}

/** strictPersonnelCsvSource (with a row limit) over a stream of decoded text pieces. Same states, checks and order. */
class StrictCsvStream{
 private state:'plain'|'quoted'|'closed'='plain';
 private field='';private fieldLength=0;private row:string[]=[];private rows=0;private cells=0;
 private started=false;private quotePending=false;private carriageReturnPending=false;
 constructor(private readonly onRow:(row:string[])=>void){}
 feed(text:string){
  const length=text.length;if(!length)return;
  let i=0;
  // text.replace(/^\uFEFF/,'') on the whole decoded file.
  if(!this.started){this.started=true;if(text.charCodeAt(0)===0xfeff)i=1;}
  if(this.carriageReturnPending){this.carriageReturnPending=false;if(text.charCodeAt(i)===10)i++;}
  if(this.quotePending){
   // The previous piece ended on a quote inside a quoted cell: '""' is one literal quote, anything else closes it.
   this.quotePending=false;
   if(text.charCodeAt(i)===34){this.field+='"';this.fieldLength++;i++;}else this.state='closed';
  }
  let segment=-1;
  for(;i<length;i++){
   if(this.fieldLength>FIELD_CHARS)throw budgetError();
   const c=text.charCodeAt(i);
   if(this.state==='quoted'){
    if(c===34){
     if(segment>=0){this.field+=text.slice(segment,i);segment=-1;}
     if(i+1===length)this.quotePending=true;
     else if(text.charCodeAt(i+1)===34){segment=i+1;this.fieldLength++;i++;}
     else this.state='closed';
    }else{if(segment<0)segment=i;this.fieldLength++;}
    continue;
   }
   if(c===44){if(segment>=0){this.field+=text.slice(segment,i);segment=-1;}this.endField();continue;}
   if(c===13||c===10){
    if(segment>=0){this.field+=text.slice(segment,i);segment=-1;}
    this.endRow();
    if(c===13){if(i+1===length)this.carriageReturnPending=true;else if(text.charCodeAt(i+1)===10)i++;}
    continue;
   }
   if(this.state==='closed')throw malformedError(this.rows);
   if(c===34){if(this.fieldLength!==0)throw malformedError(this.rows);this.state='quoted';}
   else{if(segment<0)segment=i;this.fieldLength++;}
  }
  if(segment>=0)this.field+=text.slice(segment);
 }
 end(){
  if(this.quotePending){this.quotePending=false;this.state='closed';}
  if(this.state==='quoted')throw malformedError(this.rows);
  if(this.fieldLength!==0||this.row.length||this.state==='closed')this.endRow();
 }
 private endField(){
  if(this.row.length>=ROW_FIELDS||++this.cells>CSV_CELLS)throw budgetError();
  this.row.push(this.field);this.field='';this.fieldLength=0;this.state='plain';
 }
 private endRow(){
  this.endField();
  const row=this.row;this.row=[];
  if(row.some(value=>value!=='')){if(this.rows>=ROW_LIMIT)throw budgetError();this.rows++;this.onRow(row);}
 }
}

async function stageCsv(parts:Uint8Array[]):Promise<BankImportStaged>{
 const stage=new BankRecordStage(),parser=new StrictCsvStream(row=>stage.add(row)),decoder=new TextDecoder();
 let visible=false,parseError:unknown=null;
 const take=(text:string)=>{
  // readImportFile refuses a whitespace-only file (text.trim()==='') before any parse error.
  if(!visible&&/\S/.test(text))visible=true;
  if(parseError===null)try{parser.feed(text);}catch(error){parseError=error;stage.release();}
 };
 for(let k=0;k<parts.length;k++){
  const part=parts[k];parts[k]=EMPTY;
  take(decoder.decode(part,{stream:true}));
  if(parseError!==null&&visible)break;
 }
 if(parseError===null||!visible)take(decoder.decode());
 if(parseError===null)try{parser.end();}catch(error){parseError=error;stage.release();}
 if(!visible)throw new ImportFileError('EMPTY_FILE');
 if(parseError!==null)throw parseError;
 return stage.finish();
}
const EMPTY=new Uint8Array(0);

type Cell=string|number|boolean|Date|null|undefined;
type Range={s:{r:number;c:number};e:{r:number;c:number}};
/** SheetJS 0.20.3 safe_decode_range, which sheet_to_json applies to a sheet's '!ref' string. */
function safeDecodeRange(range:string):Range{
 const o={s:{c:0,r:0},e:{c:0,r:0}};let idx=0,i=0,cc=0;const len=range.length;
 for(idx=0;i<len;++i){if((cc=range.charCodeAt(i)-64)<1||cc>26)break;idx=26*idx+cc;}
 o.s.c=--idx;
 for(idx=0;i<len;++i){if((cc=range.charCodeAt(i)-48)<0||cc>9)break;idx=10*idx+cc;}
 o.s.r=--idx;
 if(i===len||cc!=10){o.e.c=o.s.c;o.e.r=o.s.r;return o;}
 ++i;
 for(idx=0;i!=len;++i){if((cc=range.charCodeAt(i)-64)<1||cc>26)break;idx=26*idx+cc;}
 o.e.c=--idx;
 for(idx=0;i!=len;++i){if((cc=range.charCodeAt(i)-48)<0||cc>9)break;idx=10*idx+cc;}
 o.e.r=--idx;
 return o;
}

/**
 * The rows workbookToCsvTexts' sheetCsv keeps (blank rows dropped, dates and numbers rendered), in sheet order, read
 * SHEET_WINDOW_ROWS at a time. sheet_to_json with header:1 builds each row independently, so windows over the same
 * columns concatenate to its whole-sheet result.
 */
function* sheetRows(XLSX:typeof import('xlsx'),ws:import('xlsx').WorkSheet|undefined):Generator<Cell[]>{
 const ref=ws?.['!ref'];if(!ws||ref==null)return;
 const range=safeDecodeRange(ref);
 for(let start=range.s.r;start<=range.e.r;start+=SHEET_WINDOW_ROWS){
  const window={s:{r:start,c:range.s.c},e:{r:Math.min(start+SHEET_WINDOW_ROWS-1,range.e.r),c:range.e.c}};
  const aoa=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,blankrows:false,range:window}) as Cell[][];
  for(const row of aoa){
   const mapped=row.map(cell=>cell instanceof Date?toIsoDate(cell):typeof cell==='number'?numberToPlainString(cell):cell);
   if(mapped.some(c=>c!=null&&String(c).trim()!==''))yield mapped;
  }
 }
}

/**
 * Feeds sheet rows to the record builder as if rowsToCsvText's CSV text had been re-read by the strict parser: the
 * text's UTF-8 size (readImportFile's ceiling), its leading byte-order mark strip and the parser's cell budgets.
 * The serialization quotes every cell that needs it, so the parser can only refuse it on those budgets.
 */
class SheetCsvProjection{
 bytes=0;rows=0;parseError:unknown=null;private cells=0;
 constructor(private readonly stage:BankRecordStage){}
 add(mapped:Cell[]){
  const length=mapped.length,cells:string[]=new Array(length);
  for(let j=0;j<length;j++){
   const value=mapped[j],text=value==null?'':String(value);
   const quoted=/[",\r\n]/.test(text);
   this.bytes+=Buffer.byteLength(text,'utf8')+(quoted?2+(text.match(/"/g)?.length??0):0);
   cells[j]=text;
  }
  this.bytes+=length-1+2;
  if(this.rows++===0&&cells[0]?.charCodeAt(0)===0xfeff&&!/[",\r\n]/.test(cells[0]))cells[0]=cells[0].slice(1);
  if(this.parseError!==null)return;
  for(let j=0;j<length;j++){
   if(cells[j].length>FIELD_CHARS||j>=ROW_FIELDS||++this.cells>CSV_CELLS){this.refuse();return;}
  }
  if(this.rows>ROW_LIMIT){this.refuse();return;}
  this.stage.add(cells);
 }
 private refuse(){this.parseError=budgetError();this.stage.release();}
}

async function stageWorkbook(bytes:Uint8Array):Promise<BankImportStaged>{
 const stage=new BankRecordStage(),projection=new SheetCsvProjection(stage);
 try{
  const XLSX=await import('xlsx');
  // The options of workbookToCsvTexts for these bounds, plus three that change only storage and presentation fields
  // sheet_to_json(raw:true) never reads: dense cell arrays, no formatted text (`w`) and no rich-text HTML (`h`).
  const wb=XLSX.read(bytes,{type:'array',cellDates:true,sheetRows:ROW_LIMIT+1,dense:true,cellText:false,cellHTML:false});
  let cells=0;if(wb.SheetNames.length>32)throw Error('FILE_TOO_LARGE');
  for(const name of wb.SheetNames){const ws=wb.Sheets[name],ref=ws?.['!fullref']??ws?.['!ref'];if(!ref)continue;
   const range=XLSX.utils.decode_range(ref),height=range.e.r-range.s.r+1,width=range.e.c-range.s.c+1;
   cells+=height*width;if(height>ROW_LIMIT||width>256||cells>MAX_CELLS)throw Error('FILE_TOO_LARGE');
  }
  const firstName=wb.SheetNames[0];
  if(!firstName)throw new Error('EMPTY_SHEET');
  for(const row of sheetRows(XLSX,wb.Sheets[firstName]))projection.add(row);
  if(!projection.rows)throw new Error('EMPTY_SHEET');
  const key=(s:string)=>s.trim().toLowerCase();
  if(new Set(wb.SheetNames.map(key)).size!==wb.SheetNames.length)throw new Error('UNEXPECTED_SHEET');
  const allowed=new Set(ALLOWED_SHEETS.map(key));
  for(const name of wb.SheetNames)if(name!==firstName&&!allowed.has(key(name))&&!sheetRows(XLSX,wb.Sheets[name]).next().done)throw new Error('UNEXPECTED_SHEET');
 }catch(e){
  stage.release();
  throw new ImportFileError((e as Error)?.message==='FILE_TOO_LARGE'?'FILE_TOO_LARGE':(e as Error)?.message === 'EMPTY_SHEET' ? 'EMPTY_SHEET' : (e as Error)?.message==='UNEXPECTED_SHEET'?'UNEXPECTED_SHEET':'FILE_READ_FAILED');
 }
 if(projection.bytes>BANK_IMPORT_MAX_BYTES){stage.release();throw new ImportFileError('FILE_TOO_LARGE');}
 // The projected text holds a non-whitespace character (every kept row has one), so its EMPTY_SHEET check passes.
 if(projection.parseError!==null)throw projection.parseError;
 return stage.finish();
}

/**
 * Decode and stage an uploaded Bank & Statutory file from its stored parts, in order. Takes ownership of `parts`:
 * each entry is released once read so the raw file and the staged rows are not both held for a CSV.
 */
export async function stageBankImportSource(name:string,parts:Uint8Array[]):Promise<BankImportStaged>{
 const format=importFileFormat(name);
 if(!format)throw new ImportFileError('UNSUPPORTED_FILE_TYPE');
 let size=0;for(const part of parts)size+=part.length;
 if(size>BANK_IMPORT_MAX_BYTES)throw new ImportFileError('FILE_TOO_LARGE');
 if(format==='csv')return stageCsv(parts);
 // One plain byte array, as File.arrayBuffer() gave SheetJS before (never a view into a pooled buffer).
 const bytes=new Uint8Array(size);let offset=0;
 for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 parts.length=0;
 return stageWorkbook(bytes);
}

/** The records of one staged batch, as decodeBankImportSource's `records` slice: same keys, order and values. */
export function bankImportStagedRecords(staged:BankImportStaged,batch:number):Record<string,string>[]{
 const rows=JSON.parse(staged.batches[batch].toString('utf8')) as string[][];
 return rows.map(values=>Object.fromEntries(staged.headers.map((header,i)=>[header,values[i]])));
}
