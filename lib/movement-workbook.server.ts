import 'server-only';
/**
 * ac6645ec (ADR-0156) — the Movement import template: Instructions, ONE Movements sheet with the eight
 * approved columns, a Reference sheet (event types × allowed System Fields, the exact Company ID for every
 * company the user may import for, and per-company allowed values) and hidden drop-down lists. The workbook
 * is signed to the tenant and the movement-type catalogue; it binds no company and carries no internal id.
 * The retired per-type workbooks (one sheet per type, bound to one company) are refused with a message to
 * download the new template.
 */
import {createHash} from 'node:crypto';
import {SaxesParser} from 'saxes';
import type {MovementImportCatalog,MovementImportOption} from '../core/movement-import';
import {readSpreadsheetArchive,decodeSpreadsheetXml,SpreadsheetArchiveError,type SpreadsheetArchive} from './spreadsheet-archive';
import {movementWorkbookScalarChoices,movementWorkbookChoiceLabel,type MovementWorkbookType} from './movement-workbook-layout';
import {signMovementTemplate,verifyMovementTemplate} from './movement-workbook-metadata.server';
import {MOVEMENT_IMPORT_LIMITS,type MovementImportRecord} from './movement-import-contract';
import {MOVEMENT_ACTIONS,MOVEMENT_COLUMNS,MOVEMENT_SHEET,movementActionLabel,movementColumnCaptions,movementColumnsFor,movementHeaderIssue,movementHeaderVersion,movementRowsToRecords,movementSystemFields,movementTypeDisplay,type MovementSheetRow} from './movement-import-rows';
import type {MovementFormField} from './movement-form-contract';
import type {PersonnelLabelResolver} from './personnel-import-contract';
import {personnelImportLabelResolvers} from './personnel-import-labels.server';
import {parseCsv} from './csv';
export const MOVEMENT_WORKBOOK_LIMITS={maxBytes:5_000_000,maxExpandedBytes:64_000_000,maxEntries:6000,maxCells:650_000} as const;
/**
 * d9e33556 — ONE per-sheet-role contract shared by the generator, the bounded archive inspection and the
 * SheetJS read. Only the part the workbook binds to the sheet named exactly "Reference" may use the larger
 * row bound (the generated catalogue of allowed values); every other sheet, including an unknown one, keeps
 * the standard bound. Movements data limits are separate and unchanged: MOVEMENT_IMPORT_LIMITS (200 entered
 * rows, 50 employees) are reported by movementRowsToRecords, and a value beyond the eight columns is
 * workbook_columns_changed. The archive byte, expanded, entry and cell budgets apply to the whole file.
 */
export const MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS=10_005;
export const MOVEMENT_WORKBOOK_SHEET_ROWS={Instructions:MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS,[MOVEMENT_SHEET]:MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS,Reference:50_000,Lists:MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS,_meta:MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS} as const;
const sheetRowBound=(name:string)=>Object.hasOwn(MOVEMENT_WORKBOOK_SHEET_ROWS,name)?MOVEMENT_WORKBOOK_SHEET_ROWS[name as keyof typeof MOVEMENT_WORKBOOK_SHEET_ROWS]:MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS;
/** SheetJS must see every row the inspection admitted, so a formula below a truncation point cannot hide. */
const SHEETJS_ROWS=Math.max(...Object.values(MOVEMENT_WORKBOOK_SHEET_ROWS))+1;
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function business(value:unknown){const s=value==null?'':String(value);if(s.length>32767||UUID.test(s))throw new Error('workbook_business_value_invalid');return s;}
/** Binds the tenant's active movement types (code, label, behaviour); a changed catalogue needs a new download.
 * 1d58019a Step 2 — each type also carries its controls (offered termination reasons with their names, and
 * Field Controls), so a changed reason catalogue or rule is a changed catalogue too. */
export function movementWorkbookCatalogue(catalog:Pick<MovementImportCatalog,'types'>){return createHash('sha256').update(JSON.stringify({version:2,types:catalog.types})).digest('hex');}
const col=(n:number)=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const ALLOWED_SHEETS=Object.keys(MOVEMENT_WORKBOOK_SHEET_ROWS);
export type MovementTemplateCompany={code:string;name:string;catalog:MovementImportCatalog;companyId:string};
export type MovementTemplateInput={tenantId:string;types:MovementWorkbookType[];companies:MovementTemplateCompany[];resolve:PersonnelLabelResolver};
const optionCode=(option:MovementImportOption)=>option.codes?.[0]??(UUID.test(option.value)?'':option.value);
/** Builds the single-sheet template. Every cell is business text; no internal id leaves the server. */
export async function buildMovementWorkbook(p:MovementTemplateInput){
 const XLSX=await import('xlsx'),{default:JSZip}=await import('jszip');
 const words=(key:string,fallback:string)=>p.resolve('people.import.movement.sheet.'+key,fallback);
 if(!p.types.length)throw new Error('unknown_or_inactive_event_type');
 const captions=movementColumnCaptions(p.resolve).map(business),now=new Date();
 const meta=signMovementTemplate({tenantId:p.tenantId,downloadedAt:now.toISOString(),catalogue:movementWorkbookCatalogue({types:p.types}),captions});
 const wb=XLSX.utils.book_new();
 const instructions=[
  [p.resolve('people.import.movement.title','Movement Import')],
  [words('guideRows','Use the Movements sheet. Enter one row for each field that changes. Rows with the same Company ID, Employee ID, Effective Date and Event Type are imported together as one movement.')],
  [words('guideCompany','Company ID is the Company Code shown in People Management, or the registration number where a company has no code. The Reference sheet lists the exact value for every company you may import for.')],
  [words('guideFields','Event Type and System Fields have drop-down lists. The Reference sheet shows which System Fields each event type may change and the allowed values for each company.')],
  [words('guideBefore','Before is the value you expect the employee to have now. It is checked before anything is saved: if the record has changed since you prepared the file, that employee is stopped with a message and nothing is overwritten. Leave Before blank to skip the check.')],
  [words('guideAfter','After is the new value. Use the code from the Reference sheet for grades, departments, positions, locations and other lists.')],
  [words('guideDates','Dates: DD-MMM-YYYY (for example 01-Jan-2027) or YYYY-MM-DD. Blacklist uses the current Kuala Lumpur day.')],
  [words('guideLimits','At most 200 rows and 50 employees per file, and 20 movements per employee. Each employee’s movements are saved together or not at all; other employees still go through.')],
  [words('guideNoRow','A movement with no field change (for example a Confirmation with no salary change) is one row with System Fields, Before and After left blank.')],
  [words('guideAction','Action: leave it blank or choose Create to record a new movement. Choose Update to correct an existing movement or Delete to roll it back. Update and Delete need the Movement Event ID and a Reason.')],
  [words('guideMovementId','Movement Event ID: copy it from the Movement Event ID column of the employee’s Employment History download (Download Excel on the Movement tab). It must belong to the employee in that row.')],
  [words('guideUpdate','Update: enter one row for each field to correct, with the new value in After. Blank cells keep the recorded value, including a blank Effective Date or Event Type; nothing is cleared. Delete: one row with System Fields, Before and After left blank.')],
  [words('guideReason','Reason: why the movement is being corrected or rolled back. It is required for Update and Delete and is kept in the audit history. Where payroll for the period is already closed, you confirm that on screen before saving.')],
 ];
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(instructions.map(row=>row.map(business))),'Instructions');
 const rows=MOVEMENT_IMPORT_LIMITS.rows;
 const data:string[][]=[captions,...Array.from({length:rows},()=>MOVEMENT_COLUMNS.map(()=>''))];
 const sheet=XLSX.utils.aoa_to_sheet(data);
 for(let r=1;r<=rows;r++)for(let c=0;c<MOVEMENT_COLUMNS.length;c++){const address=col(c)+(r+1),cell=sheet[address]??={t:'s',v:''};cell.z='@';}
 sheet['!cols']=MOVEMENT_COLUMNS.map(column=>({wch:column==='employeeName'||column==='systemField'?26:column==='before'||column==='after'||column==='reason'?30:column==='movementId'?38:18}));
 XLSX.utils.book_append_sheet(wb,sheet,MOVEMENT_SHEET);
 // Reference: event types × System Fields, Company IDs, then each company's allowed values.
 const reference:string[][]=[[words('referenceTypes','Event types and the System Fields each may change')],[words('colEventType','Event Type'),words('colCode','Code'),words('colFields','System Fields')]];
 const fieldLabels=new Map<string,string>();
 for(const type of p.types){const fields=movementSystemFields(type,p.resolve);for(const f of fields)if(!fieldLabels.has(f.key))fieldLabels.set(f.key,f.label);reference.push([movementTypeDisplay(p.types,type,p.resolve),type.code,fields.map(f=>f.label).join(' · ')||words('noFields','No field change (leave System Fields blank)')].map(business));}
 reference.push([],[words('referenceCompanies','Company ID to enter for each company')],[captions[0],words('colCompany','Company')]);
 for(const company of p.companies)reference.push([company.code,company.name].map(business));
 reference.push([],[words('referenceValues','Allowed values for each company')],[captions[0],captions[5],words('colValue','Value to enter in After'),words('colLabel','Meaning')]);
 const referenceFields:MovementFormField[]=['businessUnitId','departmentId','positionId','gradeId','locationId','managerEmploymentId','orgDivision','employmentCategory','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase'];
 for(const company of p.companies)for(const field of referenceFields){
  if(!fieldLabels.has(field))continue;
  const options=(company.catalog.fields[field]??[]).filter(option=>field!=='managerEmploymentId'||!option.isTestRecord&&option.eligible&&option.companyId===company.companyId);
  for(const option of options){const code=optionCode(option);if(code.trim())reference.push([company.code,fieldLabels.get(field)!,code,option.label||code].map(business));}
 }
 if(fieldLabels.has('companyId'))for(const company of p.companies)reference.push(['',fieldLabels.get('companyId')!,company.code,company.name].map(business));
 for(const [field,label]of fieldLabels){
  if(referenceFields.includes(field as MovementFormField)||field==='companyId'||field==='incrementAmount')continue;
  // 1d58019a Step 2 — termination reasons are the tenant's catalogue (the reasons its Termination types offer).
  for(const choice of movementWorkbookScalarChoices(field as MovementFormField,p.types))reference.push(['',label,choice.value,movementWorkbookChoiceLabel(choice,p.resolve)].map(business));
 }
 if(reference.length>MOVEMENT_WORKBOOK_SHEET_ROWS.Reference)throw new Error('movement_reference_catalog_too_large');
 const referenceSheet=XLSX.utils.aoa_to_sheet(reference);referenceSheet['!cols']=[{wch:24},{wch:28},{wch:28},{wch:40}];
 for(const [address,cell]of Object.entries(referenceSheet))if(!address.startsWith('!'))(cell as import('xlsx').CellObject).z='@';
 XLSX.utils.book_append_sheet(wb,referenceSheet,'Reference');
 const lists:string[][]=[[captions[0],captions[4],captions[5],captions[8]]];
 const columns=[p.companies.map(c=>c.code),p.types.map(type=>movementTypeDisplay(p.types,type,p.resolve)),[...fieldLabels.values()],MOVEMENT_ACTIONS.map(action=>movementActionLabel(action,p.resolve))].map(values=>[...new Set(values.filter(v=>v.trim()))]);
 if(Math.max(...columns.map(values=>values.length))+1>MOVEMENT_WORKBOOK_SHEET_ROWS.Lists)throw new Error('movement_reference_catalog_too_large');
 columns.forEach((values,c)=>values.forEach((value,r)=>{lists[r+1]??=[];lists[r+1][c]=business(value);}));
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(lists),'Lists');
 wb.Workbook??={};wb.Workbook.Names=columns.map((values,c)=>({Name:'AIHR_Movement_List_'+c,Ref:`'Lists'!$${col(c)}$2:$${col(c)}$${Math.max(2,values.length+1)}`}));
 const json=JSON.stringify(meta);XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(Array.from({length:Math.ceil(json.length/16000)},(_,i)=>[json.slice(i*16000,(i+1)*16000)])),'_meta');
 wb.Workbook.Sheets=wb.SheetNames.map(name=>({name,Hidden:name==='Lists'||name==='_meta'?1:0}));
 const zip=await JSZip.loadAsync(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));
 const path='xl/worksheets/sheet2.xml',entry=zip.file(path);if(!entry)throw new Error('workbook_layout_invalid');let text=await entry.async('string');
 text=text.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/,'<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
 if(!text.includes('<sheetViews>'))text=text.replace(/<sheetFormatPr\b|<cols>|<sheetData/,match=>'<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+match);
 const validated=[[0,0],[4,1],[5,2],[8,3]].filter(([,list])=>columns[list].length);
 const validation=`<dataValidations count="${validated.length}">${validated.map(([c,list])=>`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${col(c)}2:${col(c)}${rows+1}"><formula1>${xml('AIHR_Movement_List_'+list)}</formula1></dataValidation>`).join('')}</dataValidations>`;
 const at=text.search(/<(?:hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/);if(at<0)throw new Error('workbook_layout_invalid');
 if(validated.length)text=text.slice(0,at)+validation+text.slice(at);
 zip.file(path,text);
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 // The download must pass its own upload check unchanged: a blank template reads as zero entered rows.
 // A catalogue beyond the shared bounds fails here explicitly rather than producing a refused file.
 try{if((await readMovementWorkbookRows(bytes,{tenantId:p.tenantId,types:p.types})).length)throw new Error('workbook_layout_invalid');}
 catch(error){const code=error instanceof Error?error.message:'';if(code==='workbook_too_large'||code==='file_too_large')throw new Error('movement_reference_catalog_too_large');throw error;}
 return bytes;
}

const MAIN_NS=new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://purl.oclc.org/ooxml/spreadsheetml/main']);
const OFFICE_DOCUMENT=/\/officeDocument$/;
/** Archive refusals as finite upload codes: oversized, damaged or unsafe are distinct for the user. */
function admitArchive(bytes:Buffer):SpreadsheetArchive{
 try{return readSpreadsheetArchive(bytes,MOVEMENT_WORKBOOK_LIMITS);}
 catch(error){
  if(!(error instanceof SpreadsheetArchiveError))throw error;
  throw new Error(error.code==='tooLarge'?'file_too_large':error.code==='expandedLimit'?'workbook_too_large':error.code==='invalidArchive'?'workbook_damaged':'workbook_structure_invalid');
 }
}
/**
 * Sheet roles from the workbook part and its own relationships, before any role-specific bound is used.
 * Returns worksheet part -> row bound. Aliased, duplicate or unresolved sheets are refused.
 */
function sheetRoles(archive:SpreadsheetArchive):Map<string,number>{
 const office=(archive.relationships.get('')??[]).filter(r=>OFFICE_DOCUMENT.test(r.type));
 if(office.length!==1||office[0].part!=='xl/workbook.xml')throw new Error('workbook_structure_invalid');
 const rels=new Map((archive.relationships.get('xl/workbook.xml')??[]).map(r=>[r.id,r.part]));
 const roles=new Map<string,number>(),names=new Set<string>();
 const parser=new SaxesParser({xmlns:true});parser.on('doctype',()=>{throw new Error('workbook_structure_invalid');});
 parser.on('opentag',tag=>{
  if(tag.local!=='sheet'||!MAIN_NS.has(tag.uri))return;
  const name=Object.values(tag.attributes).find(a=>a.local==='name'&&!a.uri)?.value??'',id=Object.values(tag.attributes).find(a=>a.local==='id'&&/relationships$/.test(a.uri))?.value??'';
  const part=rels.get(id);
  if(!name||names.has(name.toLowerCase())||!part||roles.has(part))throw new Error('workbook_structure_invalid');
  names.add(name.toLowerCase());roles.set(part,sheetRowBound(name));
 });
 parser.write(decodeSpreadsheetXml(archive.parts.get('xl/workbook.xml')!)).close();
 return roles;
}
/** Strict bounded workbook structure BEFORE SheetJS parses user bytes. */
function inspect(bytes:Buffer){
 const archive=admitArchive(bytes),roles=sheetRoles(archive);let totalCells=0;
 for(const [name,data]of archive.parts){
  if(!name.endsWith('.xml'))continue;const text=decodeSpreadsheetXml(data);
  // A worksheet part that no sheet names gets the standard bound, never the Reference one.
  const maxRows=roles.get(name)??MOVEMENT_WORKBOOK_STANDARD_SHEET_ROWS;
  const parser=new SaxesParser({xmlns:true});let validationFormula=false,validationText='',inCell=false;const cellAddresses=new Set<string>();parser.on('doctype',()=>{throw new Error('workbook_structure_invalid');});
  parser.on('opentag',tag=>{
   const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value]));
   if(tag.local==='formula1'){validationFormula=true;validationText='';}
   if((tag.local==='sheetProtection'||tag.local==='workbookProtection')&&Object.keys(attrs).some(k=>/password|hashValue|algorithmName|saltValue/i.test(k)))throw new Error('workbook_password_not_supported');
   if(tag.local==='formula'||tag.local==='formula2'||['oleObject','externalReference','externalReferences'].includes(tag.local))throw new Error('workbook_structure_invalid');
   // A cell formula is refused on every sheet here, independent of how many rows SheetJS later reads.
   if(inCell&&tag.local==='f'&&MAIN_NS.has(tag.uri))throw new Error('formula_input');
   if(tag.local==='dimension'&&attrs.ref){const match=/^(?:[A-Z]+\d+:)?([A-Z]+)(\d+)$/.exec(attrs.ref);if(!match||match[1].length>3)throw new Error('workbook_structure_invalid');if(Number(match[2])>maxRows)throw new Error('workbook_too_large');}
   if(tag.local==='c'){
    const address=/^([A-Z]{1,3})([1-9]\d{0,5})$/.exec(attrs.r??'');if(!address||cellAddresses.has(attrs.r))throw new Error('workbook_structure_invalid');
    if(++totalCells>MOVEMENT_WORKBOOK_LIMITS.maxCells||Number(address[2])>maxRows)throw new Error('workbook_too_large');
    cellAddresses.add(attrs.r);inCell=true;
   }
  });
  parser.on('text',value=>{if(validationFormula){validationText+=value;if(validationText.length>100)throw new Error('workbook_structure_invalid');}});
  parser.on('closetag',tag=>{if(tag.local==='c')inCell=false;if(tag.local==='formula1'){if(!/^AIHR_Movement_List_\d+$/.test(validationText))throw new Error('workbook_structure_invalid');validationFormula=false;}});
  parser.write(text).close();
 }
 return archive;
}
const DATE_COLUMNS=new Set([3,6,7]);
/** Reads the Movements sheet rows of a signed template. Throws a finite workbook_* code on refusal. */
export async function readMovementWorkbookRows(bytes:Buffer,p:{tenantId:string;types:MovementWorkbookType[]}):Promise<MovementSheetRow[]>{
 if(!bytes.length)throw new Error('empty_file');
 inspect(bytes);const XLSX=await import('xlsx');let wb:import('xlsx').WorkBook;
 try{wb=XLSX.read(bytes,{type:'buffer',cellFormula:true,cellDates:false,cellNF:true,sheetRows:SHEETJS_ROWS});}catch{throw new Error('workbook_damaged');}
 if(new Set(wb.SheetNames.map(n=>n.toLowerCase())).size!==wb.SheetNames.length)throw new Error('workbook_structure_invalid');
 const metaSheet=wb.Sheets._meta;
 if(!metaSheet||!wb.Sheets[MOVEMENT_SHEET]){
  // The retired per-type workbook has a signed _meta of version 2 and one sheet per movement type.
  if(metaSheet){const raw=XLSX.utils.sheet_to_json<unknown[]>(metaSheet,{header:1,raw:true,blankrows:false});try{const parsed=JSON.parse(raw.map(r=>String(r[0]??'')).join(''));if(parsed?.version===2)throw new Error('workbook_old_layout');}catch(error){if(error instanceof Error&&error.message==='workbook_old_layout')throw error;}}
  throw new Error(metaSheet?'workbook_metadata_invalid':'workbook_old_layout');
 }
 for(const name of wb.Workbook?.Names??[]){if(!/^AIHR_Movement_List_\d+$/.test(name.Name)||!/^(?:'Lists'|Lists)!\$[A-Z]{1,3}\$2:\$[A-Z]{1,3}\$[1-9]\d{0,4}$/.test(name.Ref))throw new Error('workbook_structure_invalid');}
 const raw=XLSX.utils.sheet_to_json<unknown[]>(metaSheet,{header:1,raw:true,blankrows:false});if(raw.length>100||raw.some(r=>r.length!==1||typeof r[0]!=='string'))throw new Error('workbook_metadata_invalid');
 let parsed:unknown;try{parsed=JSON.parse(raw.map(r=>r[0]).join(''));}catch{throw new Error('workbook_metadata_invalid');}
 const metadata=verifyMovementTemplate(parsed,p.tenantId);
 if(metadata.catalogue!==movementWorkbookCatalogue({types:p.types}))throw new Error('workbook_catalogue_changed');
 for(const name of wb.SheetNames){const sheet=wb.Sheets[name];if(Object.values(sheet).some(c=>c&&typeof c==='object'&&'f'in c&&c.f))throw new Error('formula_input');if(!ALLOWED_SHEETS.includes(name)&&Object.values(sheet).some(c=>c&&typeof c==='object'&&'v'in c&&String(c.v??'').trim()))throw new Error('workbook_unexpected_sheet');}
 const sheet=wb.Sheets[MOVEMENT_SHEET],range=XLSX.utils.decode_range(sheet['!ref']??'A1');
 // 646355e5 slice C — a version 3 template has the first eight columns; its rows read as Create.
 const width=movementColumnsFor(metadata.version).length;
 for(let c=0;c<width;c++){const header=sheet[XLSX.utils.encode_cell({r:0,c})];if(String(header?.v??'')!==metadata.captions[c])throw new Error('workbook_columns_changed');}
 const read=(r:number,c:number)=>{const cell=sheet[XLSX.utils.encode_cell({r,c})];if(!cell||cell.v==null)return '';
  if(cell.t==='n'&&DATE_COLUMNS.has(c)&&(c===3||/[dy]/i.test(String(cell.z??''))&&!/^General$/i.test(String(cell.z??'')))){const d=XLSX.SSF.parse_date_code(Number(cell.v));if(d)return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}
  return String(cell.v);};
 const rows:MovementSheetRow[]=[];
 for(let r=1;r<=range.e.r;r++){
  for(let c=width;c<=range.e.c;c++)if(String(sheet[XLSX.utils.encode_cell({r,c})]?.v??'').trim())throw new Error('workbook_columns_changed');
  const values=MOVEMENT_COLUMNS.map((_,c)=>c<width?read(r,c):'');if(values.some(v=>v.length>32767))throw new Error('workbook_structure_invalid');
  if(values.some(v=>v.trim()))rows.push({row:r+1,values});
 }
 return rows;
}
/** The same columns as CSV (no signature: the CSV is a transport only, and every row is re-checked). The eight
 * version 3 captions read as Create only; the eleven version 4 captions add Action, Movement Event ID and Reason. */
export function readMovementCsvRows(text:string,resolvers:PersonnelLabelResolver[]):MovementSheetRow[]{
 const grid=parseCsv(text.replace(/^﻿/,''));if(!grid.length)throw new Error('empty_file');
 const issue=movementHeaderIssue(grid[0],resolvers);if(issue)throw new Error(issue);
 const width=movementColumnsFor(movementHeaderVersion(grid[0],resolvers)??4).length;
 return grid.slice(1).map((values,index)=>{if(values.slice(width).some(v=>v.trim()))throw new Error('workbook_columns_changed');return{row:index+2,values:MOVEMENT_COLUMNS.map((_,c)=>c<width?values[c]??'':'')};}).filter(row=>row.values.some(v=>v.trim()));
}
export const MOVEMENT_FILE_CODES=['file_too_large','empty_file','invalid_file','workbook_damaged','workbook_too_large','workbook_old_layout','workbook_columns_changed','workbook_metadata_invalid','workbook_catalogue_changed','workbook_structure_invalid','workbook_password_not_supported','workbook_unexpected_sheet','workbook_key_unavailable','formula_input','malformed_csv'] as const;
/** Reads an uploaded file (signed .xlsx template or the same columns as UTF-8 .csv) into movement records. */
export async function readMovementSource(name:string,content:Buffer,p:{tenantId:string;types:MovementWorkbookType[];resolve:PersonnelLabelResolver}):Promise<{records:MovementImportRecord[];fileErrors:string[]}>{
 const resolvers=[p.resolve,...personnelImportLabelResolvers];
 const lower=name.toLowerCase();let rows:MovementSheetRow[];
 try{
  if(lower.endsWith('.xlsx')){if(content.length>MOVEMENT_WORKBOOK_LIMITS.maxBytes)throw new Error('file_too_large');rows=await readMovementWorkbookRows(content,p);}
  else if(lower.endsWith('.csv')){if(content.length>MOVEMENT_IMPORT_LIMITS.bytes)throw new Error('file_too_large');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{throw new Error('invalid_file');}rows=readMovementCsvRows(text,resolvers);}
  else throw new Error('invalid_file');
 }catch(error){
  const code=error instanceof Error?error.message:'';
  return{records:[],fileErrors:[(MOVEMENT_FILE_CODES as readonly string[]).includes(code)?code:'workbook_structure_invalid']};
 }
 return movementRowsToRecords(rows,p.types,resolvers);
}
