import JSZip from 'jszip';
import { inflateRawSync } from 'node:zlib';
import { legacyLabelWorkbookStream } from './system-label-xls';
import * as XLSX from 'xlsx';
import { LABEL_IMPORT_DEFINITIONS, type LabelImportRow, type LabelImportPreviewRow } from './system-label-definition';

export const LABEL_WORKBOOK_GENERATION=2;
export const LABEL_WORKBOOK_MAX_BYTES = 5_000_000;
export const LABEL_WORKBOOK_MAX_ROWS = 500;
export const LABEL_WORKBOOK_TOTAL_ROWS = 7000;
const LABEL_FORMATTED_ROW_CEILING = 1000;
export const LABEL_EXPORT_SHEET = '_Export';
const safe = (s: string) => /^[\s]*[=+@-]/.test(s) ? "'" + s : s;

export function systemLabelTemplate(references: { companies: string[][]; grades: string[][]; employees: string[][] }): Buffer {
  const wb = XLSX.utils.book_new();
  const instructions = [
    ['System Labels — Organisation Labels'],
    ['Keep worksheet names and headers. Enter literal values; formulas are refused. Maximum 500 data rows per sheet, 7000 per workbook, 5 MB.'],
    ['Company uses the exact company name from Reference (or its ID when names are ambiguous). Company is required for company-linked labels.'],
    ['Criteria: global or companies. Criteria Companies is the complete selected-company list, separated by semicolons; it may exclude the creation Company. Global requires a group administrator.'],
    ['Import adds new codes only. An existing code in any company in that category is blocked, including archived codes. Edit existing records on the System Labels page.'],
    ['Division through Category, Grades and Grade Groups are tenant-wide; they have no Company or Criteria column.'],
    ['Code is the new identifier. Department Code maps to Name; Position Code maps to Title.'],
    ['Cost Centre and Business Unit Description are required names. Other descriptions and labels are optional.'],
    ['Head Employee Code must belong to the origin company. Blank leaves a new code without a head.'],
    ['Grade Codes contains existing active grade codes separated by semicolons. Create grades before importing their groups.'],
    ['Blocked rows are skipped; other valid new codes may be imported. Existing values are never overwritten.'],
    ['Archived or inactive records must be restored in the editor before importing. No deletion or archiving is performed.'],
    ['Sort Order and Rank are whole numbers. Blank means zero. Blank Label for profile options means Code.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  for (const d of LABEL_IMPORT_DEFINITIONS) {
    const ws = XLSX.utils.aoa_to_sheet([d.columns]);
    ws['!cols'] = d.columns.map(() => ({ wch: 24 }));
    for(let row=1;row<=LABEL_WORKBOOK_MAX_ROWS;row++)for(let col=0;col<d.columns.length;col++) {
      if(d.columns[col]==='Rank'||d.columns[col]==='Sort Order')continue;
      ws[XLSX.utils.encode_cell({r:row,c:col})]={t:'s',v:'',z:'@'};
    }
    ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:LABEL_WORKBOOK_MAX_ROWS,c:d.columns.length-1}});
    XLSX.utils.book_append_sheet(wb, ws, d.kind);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Company Name', 'Company ID'], ...references.companies.map(r => r.map(safe)), [],
    ['Grades: Code', 'Label'], ...references.grades.map(r => r.map(safe)), [],
    ['Head Employee Code', 'Company ID', 'Name'], ...references.employees.map(r => r.map(safe)),
  ]), 'Reference');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/** Inspect actual local ZIP contents and bound inflation before SheetJS reads worksheet strings. */
function checkZip(bytes:Buffer){
  if(bytes.length>LABEL_WORKBOOK_MAX_BYTES||bytes.length<22||bytes.readUInt32LE(0)!==0x04034b50)throw new Error('Upload an XLSX or XLS file no larger than 5 MB.');
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0||end+22+bytes.readUInt16LE(end+20)!==bytes.length)throw new Error('Invalid Excel archive.');
  const count=bytes.readUInt16LE(end+10);let offset=bytes.readUInt32LE(end+16),expanded=0;
  if(!count||count>160||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count)throw new Error('Unsupported Excel archive.');
  const names=new Set<string>();
  for(let n=0;n<count;n++){
    if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('Invalid Excel archive directory.');
    const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),compressed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),local=bytes.readUInt32LE(offset+42);
    if(flags&0x41||![0,8].includes(method))throw new Error('Encrypted or unsupported Excel archive.');
    expanded+=size;if(expanded>8_000_000)throw new Error('Excel workbook expands beyond the supported size.');
    const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');
    if(names.has(name)||local+30>bytes.length||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)throw new Error('Invalid Excel archive entry.');
    names.add(name);
    const localNameLength=bytes.readUInt16LE(local+26),dataStart=local+30+localNameLength+bytes.readUInt16LE(local+28);
    if(bytes.subarray(local+30,local+30+localNameLength).toString('utf8')!==name||dataStart+compressed>bytes.readUInt32LE(end+16))throw new Error('Invalid Excel archive entry.');
    const payload=bytes.subarray(dataStart,dataStart+compressed),content=method===0?payload:inflateRawSync(payload,{maxOutputLength:Math.max(1,size)});
    if(content.length!==size)throw new Error('Invalid Excel archive size.');
    if(/\.xml$/i.test(name)){
      const xml=content[0]===0xfe&&content[1]===0xff?Buffer.from(content).swap16().toString('utf16le'):(content[0]===0xff&&content[1]===0xfe||content[0]===0x3c&&content[1]===0)?content.toString('utf16le'):content.toString('utf8');
      if(/<(?:[\w.-]+:)?(?:sheetProtection|workbookProtection)\b/i.test(xml))throw new Error('Protected Excel workbooks cannot be imported.');
    }
    offset+=46+nameLength+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
  }
  if(offset!==end||!names.has('xl/workbook.xml')||names.has('xl/vbaProject.bin'))throw new Error('Upload a supported XLSX workbook without macros.');
}
function readWorkbook(bytes:Buffer):XLSX.WorkBook{
  if(!bytes.length||bytes.length>LABEL_WORKBOOK_MAX_BYTES)throw new Error('Upload an XLSX or XLS file no larger than 5 MB.');
  const legacy=bytes.subarray(0,8).toString('hex')==='d0cf11e0a1b11ae1';
  if(!legacy)checkZip(bytes);
  const input=legacy?legacyLabelWorkbookStream(bytes):bytes;
  return XLSX.read(input,{type:'buffer',cellFormula:true});
}

export function readSystemLabelWorkbook(bytes: Buffer, options:{generation?:number}={}): LabelImportRow[] {
  const wb=readWorkbook(bytes);
  if (wb.SheetNames.length > LABEL_IMPORT_DEFINITIONS.length + 3) throw new Error('Too many worksheets.');
  const rows: LabelImportRow[] = [], seen = new Set<string>();
  for (const sheet of wb.SheetNames) {
    for (const [key,cell] of Object.entries(wb.Sheets[sheet])) if(!key.startsWith('!')&&cell?.f)throw new Error(`Formula in ${sheet}!${key}. Enter a literal value.`);
    if (sheet === 'Instructions' || sheet === 'Reference' || sheet === LABEL_EXPORT_SHEET) continue;
    const definition = LABEL_IMPORT_DEFINITIONS.find(d => d.kind === sheet);
    if(seen.has(sheet))throw new Error(`Duplicate label worksheet: ${sheet}`);
    if(!definition){
      const ws=wb.Sheets[sheet],range=XLSX.utils.decode_range(ws['!fullref']??ws['!ref']??'A1');
      if(range.e.r>LABEL_FORMATTED_ROW_CEILING||range.e.c>20)throw new Error(`Unsupported worksheet ${sheet} exceeds the row or column limit.`);
      const values=XLSX.utils.sheet_to_json<string[]>(ws,{header:1,raw:false,defval:'',blankrows:true});
      let count=0;
      for(let i=1;i<values.length;i++)if(values[i].some(value=>String(value).trim())){
        if(++count>LABEL_WORKBOOK_MAX_ROWS||rows.length>=LABEL_WORKBOOK_TOTAL_ROWS)throw new Error('Worksheet limit: 500 data rows per worksheet and 7000 per workbook.');
        if(values[i].some(value=>String(value).length>1000))throw new Error('A value is too long in an unsupported worksheet.');
        rows.push({sheet,row:i+1,values:{Code:String(values[i][0]??'').trim()}});
      }
      // An unrecognised one-line sheet may contain data rather than a header. Do not silently drop it.
      if(!count&&values[0]?.some(value=>String(value).trim())){
        if(rows.length>=LABEL_WORKBOOK_TOTAL_ROWS||values[0].some(value=>String(value).length>1000))throw new Error('Unsupported worksheet exceeds the supported size.');
        rows.push({sheet,row:1,values:{Code:String(values[0][0]??'').trim()}});
      }
      continue;
    }
    seen.add(sheet);
    const ws = wb.Sheets[sheet];
    const range = XLSX.utils.decode_range(ws['!fullref'] ?? ws['!ref'] ?? 'A1');
    if (range.e.r > LABEL_FORMATTED_ROW_CEILING || range.e.c > definition.columns.length)
      throw new Error(`Worksheet ${sheet} exceeds the row or column limit.`);
    for (const [key, cell] of Object.entries(ws)) if (!key.startsWith('!') && cell?.f)
      throw new Error(`Formula in ${sheet}!${key}. Enter a literal value.`);
    const values = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: true });
    const headers=values[0];
    const legacyColumns=definition.columns.map(column=>column==='Criteria'?'Scope':column==='Criteria Companies'?'Shared Companies':column);
    const matches=(columns:readonly string[])=>JSON.stringify(headers)===JSON.stringify(columns)||JSON.stringify(headers)===JSON.stringify([...columns,'Status']);
    const legacy=definition.scope==='company' && (options.generation??LABEL_WORKBOOK_GENERATION)===2 && matches(legacyColumns);
    if (!matches(definition.columns) && !legacy)throw new Error(`Headers do not match the template in ${sheet}.`);
    let dataRows=0;
    for (let i = 1; i < values.length; i++) {
      if (!values[i].some(v => String(v).trim())) continue;
      if (++dataRows>LABEL_WORKBOOK_MAX_ROWS||rows.length>=LABEL_WORKBOOK_TOTAL_ROWS)throw new Error('Worksheet limit: 500 data rows per worksheet and 7000 per workbook. Narrow the selected lists.');
      const fields = Object.fromEntries(definition.columns.map((c, n) => [c, String(values[i][n] ?? '').trim()]));
      if (Object.values(fields).some(v => v.length > 1000)) throw new Error(`A value is too long in ${sheet}, row ${i + 1}.`);
      if(legacy) {
        const scope=fields.Criteria;
        if(scope==='own'||scope==='shared') {
          if(scope==='own' && fields['Criteria Companies'])throw new Error('Legacy own scope cannot contain Shared Companies.');
          if(scope==='shared' && !fields['Criteria Companies'])throw new Error('Legacy shared scope requires Shared Companies.');
          fields.Criteria='companies';
          fields['Criteria Companies']=[fields.Company,fields['Criteria Companies']].filter(Boolean).join(';');
        }
      }
      rows.push({ sheet, row: i + 1, values: fields, ...(legacy?{warnings:['Older Criteria headers were converted. Download the current template for the next upload.']}: {}) });
    }
  }
  if(!seen.size)throw new Error('Unknown workbook: no recognised category sheets. Download the System Labels template.');
  return rows;
}

export function systemLabelErrorWorkbook(rows: LabelImportPreviewRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Worksheet', 'Row', 'Code', 'Result', 'Message'],
    ...rows.filter(r => r.outcome === 'error'||r.outcome === 'skip').map(r => [safe(r.sheet), r.row, safe(r.values.Code??r.values.Name??''), r.outcome, safe(r.message)]),
  ]), 'Errors');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}


export function systemLabelExportId(bytes:Buffer):string|null {
  const wb=readWorkbook(bytes);
  const id=wb.Sheets[LABEL_EXPORT_SHEET]?.B2?.v;
  if(id==null)return null;
  if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid export metadata.');
  return id;
}

type LabelWorkbookReferences={companies:string[][];grades:string[][];employees:string[][]};
/** One builder for blank and populated templates. ZIP changes add standard Office worksheet features
 * without a second record owner, formulas, macros or a second spreadsheet dependency. */
export async function buildSystemLabelWorkbook(p:{references:LabelWorkbookReferences;kinds:string[];rows?:Record<string,Record<string,string>[]>;includeStatus?:boolean;exportId?:string}):Promise<Buffer> {
  const definitions=LABEL_IMPORT_DEFINITIONS.filter(d=>p.kinds.includes(d.kind));
  if(definitions.length!==new Set(p.kinds).size||!definitions.length)throw new Error('Select valid lists.');
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
    ['System Labels'],['Keep worksheet names and headers. Maximum 500 data rows per list, 7000 per workbook, 5 MB.'],
    ['Import adds new codes only. Existing codes in that category, for any company, are blocked. Company is creation ownership; Criteria controls availability independently.'],
    ['Use the System Labels page to edit existing records. Uploading current data never updates or overwrites its saved values.'],
    ['Status is informational and ignored on upload. Removed workbook rows never delete records.'],
    ['Review new additions and blocked rows before confirming. Downloaded files may contain records you can view but cannot edit.'],
    ['Every supported data sheet is checked. Blocked rows are skipped; other valid new codes may be imported.'],
    ['Company and Head dropdowns provide reference values; heads must belong to the origin company.'],
    ['Criteria Companies and Grade Codes accept semicolon-separated values. Global leaves Criteria Companies blank; companies requires a nonempty complete list, including the creation Company only when it should use the code. Dropdowns offer one value at a time; upload validates the completed list.'],
  ]),'Instructions');
  for(const d of definitions){
    const values=p.rows?.[d.kind]??[];
    if(values.length>LABEL_WORKBOOK_MAX_ROWS)throw new Error('A selected list exceeds 500 rows. Narrow the companies or lists.');
    const columns=p.includeStatus?[...d.columns,'Status']:d.columns;
    const ws=XLSX.utils.aoa_to_sheet([columns,...values.map(row=>columns.map(key=>['Rank','Sort Order'].includes(key)&&row[key]!=null&&row[key]!==''?Number(row[key]):row[key]??''))]);
    ws['!cols']=columns.map(key=>({wch:key==='Description'?40:key==='Company'||key==='Criteria Companies'?30:24}));
    const formattedEnd=Math.min(LABEL_FORMATTED_ROW_CEILING,Math.max(500,values.length+100));
    for(let row=1;row<=formattedEnd;row++)for(let col=0;col<columns.length;col++){
      const key=XLSX.utils.encode_cell({r:row,c:col});
      if(!ws[key])ws[key]={t:'s',v:''};
      if(!['Rank','Sort Order'].includes(columns[col]))ws[key].z='@';
    }
    ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:formattedEnd,c:columns.length-1}});
    XLSX.utils.book_append_sheet(wb,ws,d.kind);
  }
  const refRows:unknown[][]=[['Company Name','Company ID','Criteria','','Head Employee Code','Company ID','Grade Code','Label']];
  const count=Math.max(p.references.companies.length,p.references.employees.length,p.references.grades.length,3);
  if(count>10000)throw new Error('Reference lists exceed the supported size. Narrow the selection.');
  for(let i=0;i<count;i++)refRows.push([p.references.companies[i]?.[0]??'',p.references.companies[i]?.[1]??'',['global','companies'][i]??'','',p.references.employees[i]?.[0]??'',p.references.employees[i]?.[1]??'',p.references.grades[i]?.[0]??'',p.references.grades[i]?.[1]??'']);
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(refRows),'Reference');
  if(p.exportId){XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Version','Export ID'],['1',p.exportId]]),LABEL_EXPORT_SHEET);wb.Workbook={Sheets:wb.SheetNames.map(name=>({name,Hidden:name===LABEL_EXPORT_SHEET?2:0}))};}
  const zip=await JSZip.loadAsync(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));
  const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  zip.file('xl/styles.xml',styles);
  for(let index=0;index<wb.SheetNames.length;index++){
    const name=wb.SheetNames[index],path=`xl/worksheets/sheet${index+1}.xml`,file=zip.file(path);
    if(!file||name===LABEL_EXPORT_SHEET)continue;
    let xml=await file.async('string');
    const view='<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
    xml=xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/,view);
    if(!xml.includes('<sheetViews>'))xml=/<dimension[^>]*\/>/.test(xml)?xml.replace(/(<dimension[^>]*\/>)/,'$1'+view):xml.replace(/(<worksheet[^>]*>)/,'$1'+view);
    xml=xml.replace(/<c\b([^>]*?)>/g,(all,attrs:string)=>{
      const address=/\br="([A-Z]+)(\d+)"/.exec(attrs),header=address?.[2]==='1';
      const text=/\bt="(?:s|str|inlineStr)"/.test(attrs);
      return '<c'+attrs.replace(/\s+s="[^"]*"/g,'')+` s="${header?2:text?1:0}">`;
    });
    const d=definitions.find(d=>d.kind===name);
    if(d){
      const validations:string[]=[];
      const ranges:Record<string,string>={Company:`Reference!$A$2:$A$${Math.max(2,p.references.companies.length+1)}`,Criteria:'Reference!$C$2:$C$3','Criteria Companies':`Reference!$A$2:$A$${Math.max(2,p.references.companies.length+1)}`,'Head Employee Code':`Reference!$E$2:$E$${Math.max(2,p.references.employees.length+1)}`,'Grade Codes':`Reference!$G$2:$G$${Math.max(2,p.references.grades.length+1)}`};
      // Cross-sheet list validation uses a quoted INDIRECT reference, supported by Excel and LibreOffice.
      for(const [column,range] of Object.entries(ranges)){
        const at=d.columns.indexOf(column);if(at<0)continue;
        const letter=XLSX.utils.encode_col(at);
        validations.push(`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${letter}2:${letter}1001"><formula1>INDIRECT(&quot;${range}&quot;)</formula1></dataValidation>`);
      }
      const validationXml=validations.length?`<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`:'';
      xml=xml.replace('</sheetData>',`</sheetData><autoFilter ref="A1:${XLSX.utils.encode_col(d.columns.length-(p.includeStatus?0:1))}${(p.rows?.[name]?.length??0)+1}"/>${validationXml}`);
    }
    zip.file(path,xml);
  }
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  checkZip(bytes);
  // Export is never allowed to create a workbook that its own importer refuses or truncates.
  readSystemLabelWorkbook(bytes);
  return bytes;
}
