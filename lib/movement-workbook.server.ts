import 'server-only';
import {createHash} from 'node:crypto';
import {SaxesParser} from 'saxes';
import type {MovementImportCatalog,MovementImportOption} from '../core/movement-import';
import {readSpreadsheetArchive,decodeSpreadsheetXml} from './spreadsheet-archive';
import {movementWorkbookLayout,movementTabNames,movementWorkbookRequirements,movementWorkbookScalarChoices,type MovementWorkbookColumn,type MovementWorkbookType} from './movement-workbook-layout';
import {signMovementWorkbook,verifyMovementWorkbook,type MovementWorkbookMetadata,type MovementWorkbookBinding} from './movement-workbook-metadata.server';
import {movementInputRecord,movementRecordLimits} from './movement-type-csv';
import {MOVEMENT_IMPORT_LIMITS,type MovementImportRecord,type MovementImportEmployee} from './movement-import-contract';
import type {PersonnelLabelResolver} from './personnel-import-contract';
import {personnelImportLabelResolvers} from './personnel-import-labels.server';
import {todayInKualaLumpur} from './hr-date';
import {movementImportIssueText} from './movement-import-issues';
export const MOVEMENT_WORKBOOK_LIMITS={maxBytes:5_000_000,maxExpandedBytes:64_000_000,maxEntries:6000} as const;
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function business(value:unknown){const s=value==null?'':String(value);if(s.length>32767||UUID.test(s))throw new Error('workbook_business_value_invalid');return s;}
export function movementWorkbookCatalogue(catalog:MovementImportCatalog){return createHash('sha256').update(JSON.stringify({version:2,types:catalog.types})).digest('hex');}
const col=(n:number)=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
function formula(column:MovementWorkbookColumn,columns:MovementWorkbookColumn[],row:number){
 const find=(key:string)=>{const i=columns.findIndex(c=>c.key===key);if(i<0)throw new Error('workbook_layout_invalid');return col(i)+row;};
 if(column.key==='calculated.basicSalary')return `IF(OR(${find('incrementAmount')}="",${find('current.basicSalary')}=""),"",${find('current.basicSalary')}+${find('incrementAmount')})`;
 if(column.key==='calculated.changePercent')return `IF(OR(${find('incrementAmount')}="",${find('current.basicSalary')}="",${find('current.basicSalary')}=0),"",${find('incrementAmount')}/${find('current.basicSalary')})`;
 return `IF(OR(${find('basicSalary')}="",${find('current.basicSalary')}=""),"",${find('basicSalary')}-${find('current.basicSalary')})`;
}
type ReferenceChoice={code:string;label:string;company:string};
// Company retains this workbook's existing legal-name identifier; other reference cells carry canonical codes.
function referenceCode(option:MovementImportOption,company=false){return option.codes?.[0]??(company?option.label:UUID.test(option.value)?'':option.value);}
function referenceSheetName(tabs:string[]){const used=new Set(tabs.map(name=>name.toLowerCase()));let name='Reference',n=1;while(used.has(name.toLowerCase()))name='Reference ('+(++n)+')';return name;}
type Subject={employeeCode:string;name:string;current:Record<string,string|null>;managerExclusions?:string[]};
export type MovementWorkbookDownload={tenantId:string;companyId:string;companyName:string;catalog:MovementImportCatalog;destinationCatalogs?:Record<string,MovementImportCatalog>;typeCode?:string;sourceBindings?:MovementWorkbookBinding[];subjects:Subject[];resolve:PersonnelLabelResolver;records?:MovementImportRecord[];employees?:MovementImportEmployee[]};
/** Generate business-only cells, then apply this format's explicit OOXML presentation policy. */
export async function buildMovementWorkbook(p:MovementWorkbookDownload){
 const XLSX=await import('xlsx'),{default:JSZip}=await import('jszip');
 const words=(key:string,fallback:string)=>p.resolve('people.import.movement.v2.'+key,fallback);
 const baselineGuide=words('baselineGuide','When current salary is blank, green salary calculations stay blank. Check and preview supplies the authoritative salary baseline, including blank or repeated employee rows. A recorded zero remains a salary baseline.');
 const types=p.sourceBindings?p.sourceBindings.map(binding=>{const type=p.catalog.types.find(t=>t.code===binding.code&&t.behaviour===binding.behaviour);if(!type)throw new Error('workbook_catalogue_changed');return type;}):p.typeCode?p.catalog.types.filter(t=>t.code===p.typeCode):p.catalog.types;
 if(!types.length)throw new Error('unknown_or_inactive_event_type');
 const names=p.sourceBindings?.map(b=>b.sheet)??movementTabNames(types,p.resolve),layouts=types.map((t,i)=>movementWorkbookLayout(t,p.resolve).map((c,index)=>({...c,label:p.sourceBindings?.[i].captions[index]??c.label})));
 const wb=XLSX.utils.book_new(),now=new Date(),bindings=types.map((t,i)=>({sheet:names[i],code:t.code,behaviour:t.behaviour,columns:layouts[i].map(c=>c.key),captions:layouts[i].map(c=>business(c.label)),annotationCaption:p.employees?p.resolve('people.import.movement.errors','Errors'):undefined,identities:p.sourceBindings?.[i].identities??(p.typeCode?p.subjects.map((s,index)=>({row:index+6,employeeCode:s.employeeCode})):[])}));
 const meta=signMovementWorkbook({tenantId:p.tenantId,companyId:p.companyId,companyName:p.companyName,downloadedAt:now.toISOString(),catalogue:movementWorkbookCatalogue(p.catalog),sheets:bindings});
 const instructions=[[p.resolve('people.import.movement.title','Movement Import')],[p.resolve('people.import.movement.v2.workbookHint','Grey: current records. Yellow: your entries. Green: display calculations. Current values and pay are checked again before saving.')],[words('dateGuide','Dates: DD-MMM-YYYY or YYYY-MM-DD. Blacklist uses the current Kuala Lumpur day.')],[words('sequenceGuide','Each employee’s complete sequence saves together. Unused tabs and untouched prefilled rows are skipped.')],[words('exampleGuide','Examples are guidance only; no example employee is an import row.')],[words('incrementExample','Example: increment of 100.00 on an existing employee; enter the effective day and leave other changes blank.')],[words('zeroBaselineGuide','Change % stays blank when the salary baseline is missing or zero. Review the salary history in Check and preview.')],[baselineGuide],[words('referenceGuide','Dropdowns use exact system codes from Reference. Labels explain each code. A distinct label from an older file remains supported; preview checks the row company.')],[words('type','Movement type'),words('requiredInputs','Required inputs'),words('optionalInputs','Optional inputs')],...types.map((_t,i)=>{const guide=movementWorkbookRequirements(types[i],layouts[i]);return [names[i],[...guide.required,...(guide.requiredEither.length?[p.resolve('people.import.movement.issues.blacklist_input_required','Choose Blacklisted or enter Remarks. Employee ID alone is not a blacklist instruction.')]:[])].join(' · '),guide.optional.join(' · ')];})];
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(instructions.map(row=>row.map(business))),'Instructions');
 const referenceRows:string[][]=[[],[]],referenceGroups=new Set<string>(),referenceName=referenceSheetName(names);
 const addReference=(label:string,choices:ReferenceChoice[])=>{
  const key=JSON.stringify([label,choices]);if(referenceGroups.has(key))return;referenceGroups.add(key);
  const c=referenceRows[0].length;referenceRows[0].push(business(label),'','');referenceRows[1].push(p.resolve('admin.systemLabels.col.code','Code'),p.resolve('admin.systemLabels.col.label','Label'),p.resolve('people.import.colCompany','Company'));
  choices.forEach((choice,row)=>{referenceRows[row+2]??=[];referenceRows[row+2][c]=business(choice.code);referenceRows[row+2][c+1]=business(choice.label);referenceRows[row+2][c+2]=business(choice.company);});
 };
 const lists:string[][]=[[]];const listColumns=new Map<string,{column:number;name:string}>();const validations:{sheet:number;column:number;name:string;start:number;end:number}[]=[];
 for(const [i,type]of types.entries()){
  const columns=layouts[i],matched=p.records?.filter(r=>r.cells.kind===type.code)??[];
  const rowCount=MOVEMENT_IMPORT_LIMITS.rows;
  if(p.subjects.length>rowCount||(p.sourceBindings?.[i].identities??[]).some(identity=>identity.row<6||identity.row>rowCount+5)||matched.some(record=>(record.source?.row??6)<6||(record.source?.row??6)>rowCount+5))throw new Error('too_many_rows');
  const rows:unknown[][]=[[business(type.label??p.resolve('people.detail.movement.eventType.'+type.behaviour,type.code))],[words('colourGuide','Grey = current · Yellow = input · Green = calculation')],[words('downloaded','Downloaded')+' '+todayInKualaLumpur(now)],columns.map(c=>c.other?words('otherChanges','Other changes (optional)'):''),columns.map(c=>business(c.label))];
  for(let r=0;r<rowCount;r++){
   const subject=p.typeCode?p.subjects[r]:undefined,record=matched.find(x=>(x.source?.row??0)===r+6);
   rows.push(columns.map(column=>column.key==='employeeCode'?business(record?.employeeCode??subject?.employeeCode??p.sourceBindings?.[i].identities?.find(identity=>identity.row===r+6)?.employeeCode):column.key==='employeeName'?business(subject?.name):column.role==='current'?business(subject?.current[column.key.slice(8)]):column.role==='input'?business(column.key==='incrementAmount'?record?.incrementAmount:column.field?record?.cells[column.field]:undefined):''));
  }
  const sheet=XLSX.utils.aoa_to_sheet(rows);
  for(let r=5;r<rowCount+5;r++)for(let c=0;c<columns.length;c++){
   const address=col(c)+(r+1),column=columns[c],cell=sheet[address]??={t:'s',v:''};
   if(column.role==='formula'){cell.t='n';cell.f=formula(column,columns,r+1);delete cell.v;cell.z=column.key.endsWith('changePercent')?'0.00%':'0.00';cell.c=[{a:'AIHR',t:words('formulaNote','Display only. The server recalculates from authoritative records; percentage is blank for a missing/zero baseline.')+' '+baselineGuide}];cell.c.hidden=true;}
   else if(column.field&&['effectiveDate','endDate','resignationDate','tenderResignationDate','resignationEffectiveDate'].includes(column.field)||column.role==='current'&&/Date|hiredOn/.test(column.key)){
    cell.z='dd-mmm-yyyy';const raw=String(cell.v??'');if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){cell.t='n';cell.v=(Date.parse(raw+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;}
   }else cell.z='@';
  }
  if(p.employees){
   const errors=new Map(p.employees.flatMap(e=>e.rows.map(r=>[r.row,movementImportIssueText(r.errors,p.resolve)] as const)));
   sheet[col(columns.length)+'5']={t:'s',v:p.resolve('people.import.movement.errors','Errors')};sheet['!rows']=[];sheet['!rows'][4]={hpt:30};
   for(const record of matched){const row=record.source?.row??6,text=business(errors.get(record.row));sheet[col(columns.length)+row]={t:'s',v:text};if(text)sheet['!rows'][row-1]={hpt:Math.max(30,Math.min(240,Math.ceil(text.length/60)*15))};}
   sheet['!ref']=`A1:${col(columns.length)}${rowCount+5}`;
  }
  sheet['!cols']=[...columns.map(c=>({wch:c.key==='employeeName'?28:c.role==='current'?23:27})),...(p.employees?[{wch:72}]:[])];
  XLSX.utils.book_append_sheet(wb,sheet,names[i]);
  for(const [c,column]of columns.entries()){
   if(column.role!=='input'||!column.field)continue;
   const field=column.field,entityTransfer=type.behaviour==='entityTransfer';
   const eligible=(option:MovementImportOption,companyId:string)=>field!=='managerEmploymentId'||!option.isTestRecord&&option.eligible&&option.companyId===companyId;
   const sourceOptions=field==='companyId'?p.catalog.companies:p.catalog.fields[field]??[];
   const scopedOptions=entityTransfer&&p.destinationCatalogs&&field!=='companyId'
    ?Object.entries(p.destinationCatalogs).flatMap(([companyId,catalog])=>(catalog.fields[field]??[]).filter(option=>eligible(option,companyId)).map(option=>({option,companyId})))
    :sourceOptions.filter(option=>field!=='managerEmploymentId'||!option.isTestRecord&&option.eligible&&(entityTransfer?p.catalog.companies.some(company=>company.value===option.companyId):option.companyId===p.companyId)).map(option=>({option,companyId:option.companyId??p.companyId}));
   let choices:ReferenceChoice[]=scopedOptions.map(({option,companyId})=>{const code=referenceCode(option,field==='companyId');return {code,label:option.label||code,company:p.catalog.companies.find(company=>company.value===(field==='companyId'?option.value:companyId))?.label??p.companyName};}).filter(choice=>choice.code.trim()!=='');
   if(!choices.length)choices=movementWorkbookScalarChoices(field).map(option=>({code:option.value,label:p.resolve(option.labelKey,option.value),company:''}));
   if(!choices.length)continue;if(choices.length>10000)throw new Error('movement_reference_catalog_too_large');
   addReference(column.label,choices);
   const values=[...new Set(choices.map(choice=>choice.code))];
   const register=(entries:string[],first:number,last:number)=>{
    if(!entries.length)return;const listKey=JSON.stringify(entries);let reference=listColumns.get(listKey);
    if(!reference){const listColumn=lists[0].length,name='AIHR_Movement_List_'+listColumn;lists[0].push(business(column.label));for(let row=0;row<entries.length;row++){lists[row+1]??=[];lists[row+1][listColumn]=business(entries[row]);}reference={column:listColumn,name};listColumns.set(listKey,reference);wb.Workbook??={};wb.Workbook.Names??=[];wb.Workbook.Names.push({Name:name,Ref:`'Lists'!$${col(listColumn)}$2:$${col(listColumn)}$${entries.length+1}`});}
    validations.push({sheet:i+1,column:c,name:reference.name,start:first,end:last});
   };
   if(column.field==='managerEmploymentId'&&p.typeCode&&p.subjects.length){
    for(const [row,subject]of p.subjects.entries()){
     const excluded=new Set(subject.managerExclusions??[]);
     const entries=[...new Set(scopedOptions.filter(({option})=>!excluded.has(option.value)).map(({option})=>referenceCode(option)).filter(code=>code.trim()!==''))];
     register(entries,row+6,row+6);
    }
    // Rows without a bound subject allow repeated IDs; canonical preview checks their self/cycle references.
    if(p.subjects.length<rowCount)register(values,p.subjects.length+6,rowCount+5);
   }else register(values,6,rowCount+5);
  }
 }
 if(lists[0].length>256||lists.reduce((n,r)=>n+r.length,0)>180000)throw new Error('movement_reference_catalog_too_large');
 const referenceSheet=XLSX.utils.aoa_to_sheet(referenceRows);referenceSheet['!cols']=referenceRows[0].map((_,i)=>({wch:i%3===0?28:36}));
 for(const [address,cell]of Object.entries(referenceSheet))if(!address.startsWith('!'))(cell as import('xlsx').CellObject).z='@';
 XLSX.utils.book_append_sheet(wb,referenceSheet,referenceName);
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(lists),'Lists');
 if(Object.values(wb.Sheets).reduce((n,sheet)=>n+Object.keys(sheet).filter(key=>!key.startsWith('!')).length,0)>649900)throw new Error('movement_reference_catalog_too_large');
 const json=JSON.stringify(meta);XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(Array.from({length:Math.ceil(json.length/16000)},(_,i)=>[json.slice(i*16000,(i+1)*16000)])),'_meta');
 wb.Workbook??={};wb.Workbook.Sheets=wb.SheetNames.map(name=>({name,Hidden:name==='Lists'||name==='_meta'?1:0}));
 const zip=await JSZip.loadAsync(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));
 const styleEntry=zip.file('xl/styles.xml');if(!styleEntry)throw new Error('workbook_layout_invalid');let styles=await styleEntry.async('string');
 // SheetJS registers formats from cell.z; use the explicit custom date format instead of locale-dependent built-in14.
 const usedNumberFormats=new Set<number>();let dateFormatId:number|undefined,declaredFormats=0;
 const formatParser=new SaxesParser({xmlns:true});formatParser.on('opentag',tag=>{
  const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value]));
  if(attrs.numFmtId!=null){const id=Number(attrs.numFmtId);if(!Number.isSafeInteger(id)||id<0||id>65535)throw new Error('workbook_layout_invalid');usedNumberFormats.add(id);}
  if(tag.local==='numFmt'){declaredFormats++;if(attrs.formatCode==='dd-mmm-yyyy'&&Number(attrs.numFmtId)>=164)dateFormatId=Number(attrs.numFmtId);}
 });formatParser.write(styles).close();
 if(dateFormatId==null){
  dateFormatId=164;while(usedNumberFormats.has(dateFormatId)&&dateFormatId<=65535)dateFormatId++;if(dateFormatId>65535)throw new Error('workbook_layout_invalid');
  const format=`<numFmt numFmtId="${dateFormatId}" formatCode="dd-mmm-yyyy"/>`,open=/<numFmts\b[^>]*>/.exec(styles);
  if(open){if(/\/>$/.test(open[0]))styles=styles.replace(open[0],`<numFmts count="${declaredFormats+1}">${format}</numFmts>`);else{if(!styles.includes('</numFmts>'))throw new Error('workbook_layout_invalid');styles=styles.replace(open[0],`<numFmts count="${declaredFormats+1}">`).replace('</numFmts>',format+'</numFmts>');}}
  else styles=styles.replace(/<styleSheet\b[^>]*>/,open=>open+`<numFmts count="1">${format}</numFmts>`);
 }
 const xfs=/<cellXfs count="(\d+)"[^>]*>/,fills=/<fills count="(\d+)"[^>]*>/;const xf=xfs.exec(styles),fill=fills.exec(styles);if(!xf||!fill)throw new Error('workbook_layout_invalid');const base=Number(xf[1]),fillBase=Number(fill[1]);
 styles=styles.replace(fills,`<fills count="${fillBase+3}">`).replace('</fills>',['FFE5E7EB','FFFEF3C7','FFD1FAE5'].map(color=>`<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`).join('')+'</fills>');
 styles=styles.replace(xfs,`<cellXfs count="${base+9}">`).replace('</cellXfs>',[0,1,2,3,4,5,6,7,8].map(i=>`<xf numFmtId="${[49,49,2,dateFormatId,dateFormatId,2,2,10,49][i]}"${[3,4].includes(i)?' applyNumberFormat="1"':''} fontId="0" fillId="${i===8?0:fillBase+[0,1,2,1,0,0,1,2][i]}" borderId="0" xfId="0" applyFill="1" applyProtection="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/><protection locked="${[1,3,6].includes(i)?0:1}"/></xf>`).join('')+'</cellXfs>');zip.file('xl/styles.xml',styles);
 for(let i=0;i<types.length;i++){
  const path=`xl/worksheets/sheet${i+2}.xml`,entry=zip.file(path);if(!entry)throw new Error('workbook_layout_invalid');let text=await entry.async('string');const columns=layouts[i];
  text=text.replace(/<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>/g,(whole,attrs:string,letters:string,r:string)=>{
   let c=0;for(const letter of letters)c=c*26+letter.charCodeAt(0)-64;
   const annotation=!!p.employees&&c===columns.length+1&&Number(r)>=5;if(Number(r)<6&&!annotation)return whole;
   let style:number;
   if(annotation)style=base+8;
   else{const column=columns[c-1];if(!column)return whole;
    const unlocked=column.role==='input'||column.role==='identity'&&!bindings[i].identities.some(identity=>identity.row===Number(r));
    const date=column.field&&['effectiveDate','endDate','resignationDate','tenderResignationDate','resignationEffectiveDate'].includes(column.field)||column.role==='current'&&/Date|hiredOn/.test(column.key);const money=/basicSalary|incrementAmount/.test(column.key);
    style=column.role==='formula'?base+(column.key.endsWith('changePercent')?7:2):unlocked?base+(date?3:money?6:1):base+(date?4:money?5:0);
   }
   return '<c'+attrs.replace(/\s+s="[^" ]*"/,'')+` s="${style}">`;
  });
  const currentEnd=Math.max(0,columns.findIndex(c=>c.role==='input'));
  text=text.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/,`<sheetViews><sheetView workbookViewId="0"><pane xSplit="${currentEnd}" ySplit="5" topLeftCell="${col(currentEnd)}6" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`);
  const protection='<sheetProtection sheet="1" objects="1" scenarios="1" selectLockedCells="0" selectUnlockedCells="0"/>';
  text=text.replace('</sheetData>','</sheetData>'+protection);
  const choices=validations.filter(v=>v.sheet===i+1);if(choices.length){const validation=`<dataValidations count="${choices.length}">${choices.map(v=>`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${col(v.column)}${v.start}:${col(v.column)}${v.end}"><formula1>${xml(v.name)}</formula1></dataValidation>`).join('')}</dataValidations>`;const at=text.search(/<(?:hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/);if(at<0)throw new Error('workbook_layout_invalid');text=text.slice(0,at)+validation+text.slice(at);}
  zip.file(path,text);
 }
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});readSpreadsheetArchive(bytes,MOVEMENT_WORKBOOK_LIMITS);return bytes;
}

/** Strict bounded workbook structure BEFORE SheetJS parses user bytes. Protection is never authority. */
function inspect(bytes:Buffer){
 const archive=readSpreadsheetArchive(bytes,MOVEMENT_WORKBOOK_LIMITS);let totalCells=0;
 for(const [name,data]of archive.parts){
  // Shared archive admission resolves content types against actual parts and rejects macro/embedded relationships.
  if(!name.endsWith('.xml'))continue;const text=decodeSpreadsheetXml(data);
  const parser=new SaxesParser({xmlns:true});let validationFormula=false,validationText='';const cellAddresses=new Set<string>();parser.on('doctype',()=>{throw new Error('workbook_structure_invalid');});
  parser.on('opentag',tag=>{
   const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value]));
   if(tag.local==='formula1'){validationFormula=true;validationText='';}
   if((tag.local==='sheetProtection'||tag.local==='workbookProtection')&&Object.keys(attrs).some(k=>/password|hashValue|algorithmName|saltValue/i.test(k)))throw new Error('workbook_password_not_supported');
   if(tag.local==='formula'||tag.local==='formula2'||['oleObject','externalReference','externalReferences'].includes(tag.local))throw new Error('workbook_structure_invalid');
   if(tag.local==='dimension'&&attrs.ref){const match=/^(?:[A-Z]+\d+:)?([A-Z]+)(\d+)$/.exec(attrs.ref);if(!match||match[1].length>3||Number(match[2])>10005)throw new Error('workbook_structure_invalid');}
   if(tag.local==='c'){if(++totalCells>650000||!/^([A-Z]{1,3})([1-9]\d{0,4})$/.test(attrs.r??'')||cellAddresses.has(attrs.r))throw new Error('workbook_structure_invalid');cellAddresses.add(attrs.r);}
  });
  parser.on('text',value=>{if(validationFormula){validationText+=value;if(validationText.length>100)throw new Error('workbook_structure_invalid');}});
  parser.on('closetag',tag=>{if(tag.local==='formula1'){if(!/^AIHR_Movement_List_\d+$/.test(validationText))throw new Error('workbook_structure_invalid');validationFormula=false;}});
  parser.write(text).close();
 }
 return archive;
}
export async function readMovementWorkbook(bytes:Buffer,p:{tenantId:string;companyId:string;catalog:MovementImportCatalog;resolve:PersonnelLabelResolver}){
 inspect(bytes);const XLSX=await import('xlsx');const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true,cellDates:false,cellNF:true,sheetRows:10006});
 if(new Set(wb.SheetNames.map(n=>n.toLowerCase())).size!==wb.SheetNames.length)throw new Error('workbook_structure_invalid');
 for(const name of ['Instructions','Lists','_meta'])if(Object.values(wb.Sheets[name]??{}).some(c=>c&&typeof c==='object'&&'f'in c&&c.f))throw new Error('formula_input');
 for(const name of wb.Workbook?.Names??[]){if(!/^AIHR_Movement_List_\d+$/.test(name.Name)||!/^(?:'Lists'|Lists)!\$[A-Z]{1,3}\$2:\$[A-Z]{1,3}\$[1-9]\d{0,4}$/.test(name.Ref))throw new Error('workbook_structure_invalid');}
 const metaSheet=wb.Sheets._meta;if(!metaSheet)throw new Error('workbook_metadata_invalid');
 const raw=XLSX.utils.sheet_to_json<unknown[]>(metaSheet,{header:1,raw:true,blankrows:false});if(raw.length>100||raw.some(r=>r.length!==1||typeof r[0]!=='string'))throw new Error('workbook_metadata_invalid');
 let metadata:MovementWorkbookMetadata;try{metadata=verifyMovementWorkbook(JSON.parse(raw.map(r=>r[0]).join('')),p.tenantId,p.companyId);}catch(error){throw error instanceof Error?error:new Error('workbook_metadata_invalid');}
 if(metadata.catalogue!==movementWorkbookCatalogue(p.catalog))throw new Error('workbook_catalogue_changed');
 const referenceName=referenceSheetName(metadata.sheets.map(sheet=>sheet.sheet));
 if(Object.values(wb.Sheets[referenceName]??{}).some(cell=>cell&&typeof cell==='object'&&'f'in cell&&cell.f))throw new Error('formula_input');
 const allowed=new Set(['Instructions','Lists','_meta',referenceName,...metadata.sheets.map(s=>s.sheet)]);if(wb.SheetNames.some(name=>!allowed.has(name)&&Object.values(wb.Sheets[name]).some(c=>c&&typeof c==='object'&&(('v'in c&&String(c.v??'').trim())||('f'in c&&c.f)))))throw new Error('workbook_unexpected_sheet');
 const records:MovementImportRecord[]=[];
 for(const binding of metadata.sheets){
  const sheet=wb.Sheets[binding.sheet],type=p.catalog.types.find(t=>t.code===binding.code&&t.behaviour===binding.behaviour);if(!sheet||!type)throw new Error('workbook_catalogue_changed');
  const columns=movementWorkbookLayout(type,p.resolve);if(JSON.stringify(columns.map(c=>c.key))!==JSON.stringify(binding.columns))throw new Error('workbook_columns_changed');
  for(let c=0;c<columns.length;c++){const header=sheet[XLSX.utils.encode_cell({r:4,c})];if(header?.f||String(header?.v??'')!==binding.captions[c])throw new Error('workbook_columns_changed');}
  const range=XLSX.utils.decode_range(sheet['!ref']??'A1');if(range.e.r>MOVEMENT_IMPORT_LIMITS.rows+4||range.e.c>=columns.length+Number(!!binding.annotationCaption))throw new Error('workbook_structure_invalid');
  if(binding.annotationCaption&&String(sheet[col(columns.length)+'5']?.v??'')!==binding.annotationCaption)throw new Error('workbook_columns_changed');
  const read=(r:number,c:number)=>{const cell=sheet[XLSX.utils.encode_cell({r,c})];if(!cell||cell.v==null)return '';if(cell.t==='n'&&columns[c]?.field&&['effectiveDate','endDate','resignationDate','tenderResignationDate','resignationEffectiveDate'].includes(columns[c].field!)){const d=XLSX.SSF.parse_date_code(Number(cell.v));if(!d)return '';return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}return String(cell.v);};
  for(const [address,cell]of Object.entries(sheet)){
   if(address.startsWith('!')||!cell||typeof cell!=='object'||!('f'in cell)||!cell.f)continue;
   const a=XLSX.utils.decode_cell(address),column=columns[a.c];if(a.r<5||column?.role!=='formula'||cell.f!==formula(column,columns,a.r+1)||('F'in cell&&cell.F))throw new Error('formula_input:'+binding.sheet+':'+address);
  }
  for(let r=5;r<=range.e.r;r++){
   const values=columns.map((_,c)=>read(r,c));
   if(values.some(v=>v.length>32767))throw new Error('workbook_structure_invalid');
   const entered=columns.some((column,c)=>column.role==='input'&&values[c].trim());
   const identity=binding.identities?.find(i=>i.row===r+1);
   if(identity&&values[0]!==identity.employeeCode)throw new Error('workbook_identity_changed');
   if(!entered&&(identity||!values[0].trim()))continue;
   const record=movementInputRecord(type,columns,values,records.length+1,{sheet:binding.sheet,row:r+1},personnelImportLabelResolvers);
   if(values.some((v,c)=>['input','identity'].includes(columns[c].role)&&UUID.test(v)))record.errors.push('internal_reference_not_allowed');
   records.push(record);
  }
 }
 return {records,fileErrors:movementRecordLimits(records),metadata};
}
