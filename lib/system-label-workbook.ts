import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { readSpreadsheetArchive, decodeSpreadsheetXml, SpreadsheetArchiveError } from './spreadsheet-archive';
import { legacyLabelWorkbookStream } from './system-label-xls';
import * as XLSX from 'xlsx';
import { LABEL_IMPORT_DEFINITIONS, LABEL_TEMPLATE_DEFINITIONS, LABEL_TEMPLATE_NOTE, ORGANISATION_LABEL_KINDS, type LabelImportRow, type LabelImportPreviewRow } from './system-label-definition';

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

/** Resolve sheet identity from admitted package relationships before granting the Sample exception. */
function checkZip(bytes: Buffer) {
  let archive: ReturnType<typeof readSpreadsheetArchive>;
  try { archive=readSpreadsheetArchive(bytes,{maxBytes:LABEL_WORKBOOK_MAX_BYTES,maxExpandedBytes:8_000_000,maxEntries:160}); }
  catch(error) {
    if(error instanceof SpreadsheetArchiveError && error.code==='tooLarge')throw new Error('Upload an XLSX or XLS file no larger than 5 MB.');
    if(error instanceof SpreadsheetArchiveError && error.code==='expandedLimit')throw new Error('Excel workbook expands beyond the supported size.');
    throw new Error('Invalid Excel archive.');
  }
  const sheets:{name:string;part:string}[]=[], ids=new Set<string>(),parts=new Set<string>(),names=new Set<string>();
  const parser=new SaxesParser({xmlns:true}),path:string[]=[];
  const mainNamespaces=['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://purl.oclc.org/ooxml/spreadsheetml/main'];
  parser.on('opentag',tag=>{
    path.push(tag.local);
    if(path.length===1&&(tag.local!=='workbook'||!mainNamespaces.includes(tag.uri)))throw new Error('Invalid Excel workbook.');
    if(path.join('/')==='workbook/sheets'&&!mainNamespaces.includes(tag.uri))throw new Error('Invalid Excel workbook.');
    if(tag.local!=='sheet')return;
    if(path.join('/')!=='workbook/sheets/sheet'||!mainNamespaces.includes(tag.uri))throw new Error('Invalid or ambiguous Excel worksheet.');
    const attributes=Object.fromEntries(Object.values(tag.attributes).map(attribute=>[attribute.local,attribute.value]));
    const relationshipId=Object.values(tag.attributes).find(attribute=>attribute.local==='id'&&/\/relationships$/.test(attribute.uri))?.value;
    const relationship=archive.relationships.get('xl/workbook.xml')?.find(row=>row.id===relationshipId&&/\/worksheet$/.test(row.type));
    if(!attributes.name||!relationship||ids.has(relationshipId!)||parts.has(relationship.part)||names.has(attributes.name.toLowerCase()))throw new Error('Invalid or ambiguous Excel worksheet.');
    ids.add(relationshipId!);parts.add(relationship.part);names.add(attributes.name.toLowerCase());sheets.push({name:attributes.name,part:relationship.part});
  });
  parser.on('closetag',()=>{path.pop();});
  parser.write(decodeSpreadsheetXml(archive.parts.get('xl/workbook.xml')!)).close();
  const sample=sheets.find(sheet=>sheet.name==='Sample');
  for(const [part,content]of archive.parts){
    if(!/\.xml$/i.test(part))continue;
    const xml=new SaxesParser({xmlns:true});let protectionCount=0;
    xml.on('opentag',tag=>{
      const local=tag.local.toLowerCase();
      if(local==='workbookprotection'||local==='filesharing'&&Object.values(tag.attributes).some(attribute=>/password|hash|salt|spinCount/i.test(attribute.local)))throw new Error('Protected Excel workbooks cannot be imported.');
      if(local!=='sheetprotection')return;
      const attributes=Object.values(tag.attributes).filter(attribute=>attribute.uri!=='http://www.w3.org/2000/xmlns/');
      const booleanAttributes=new Set(['sheet','objects','scenarios','formatCells','formatColumns','formatRows','insertColumns','insertRows','insertHyperlinks','deleteColumns','deleteRows','selectLockedCells','sort','autoFilter','pivotTables','selectUnlockedCells']);
      if(++protectionCount>1||!sample||part!==sample.part||attributes.some(attribute=>attribute.uri||!booleanAttributes.has(attribute.local)||!['0','1','true','false'].includes(attribute.value)))throw new Error('Protected Excel workbooks cannot be imported.');
    });
    xml.write(decodeSpreadsheetXml(content)).close();
  }
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
    if (sheet === 'Instructions' || sheet === 'Sample' || sheet === 'Reference' || sheet === LABEL_EXPORT_SHEET) continue;
    const template=LABEL_TEMPLATE_DEFINITIONS.find(d=>d.sheet===sheet);
    const definition = LABEL_IMPORT_DEFINITIONS.find(d => d.kind === (template?.kind??sheet));
    if(definition&&seen.has(definition.kind))throw new Error(`Duplicate label worksheet: ${sheet}`);
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
    seen.add(definition.kind);
    const ws = wb.Sheets[sheet];
    const range = XLSX.utils.decode_range(ws['!fullref'] ?? ws['!ref'] ?? 'A1');
    if (range.e.r > LABEL_FORMATTED_ROW_CEILING || range.e.c > definition.columns.length)
      throw new Error(`Worksheet ${sheet} exceeds the row or column limit.`);
    for (const [key, cell] of Object.entries(ws)) if (!key.startsWith('!') && cell?.f)
      throw new Error(`Formula in ${sheet}!${key}. Enter a literal value.`);
    const values = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: true });
    const newLayout=!!template&&values[0]?.[0]===LABEL_TEMPLATE_NOTE&&values[0].slice(1).every(value=>!value);
    if(template&&!newLayout)throw new Error(`Headers do not match the template in ${sheet}.`);
    const headerRow=newLayout?1:0,headers=values[headerRow];
    const columns=newLayout?template!.columns.map(([,field])=>field):definition.columns;
    const businessHeaders=newLayout?template!.columns.map(([header])=>header):definition.columns;
    const legacyColumns=definition.columns.map(column=>column==='Criteria'?'Scope':column==='Criteria Companies'?'Shared Companies':column);
    const matches=(columns:readonly string[])=>JSON.stringify(headers)===JSON.stringify(columns)||JSON.stringify(headers)===JSON.stringify([...columns,'Status']);
    const legacy=!newLayout&&definition.scope==='company' && (options.generation??LABEL_WORKBOOK_GENERATION)===2 && matches(legacyColumns);
    if (!(newLayout?JSON.stringify(headers)===JSON.stringify(businessHeaders):matches(definition.columns)) && !legacy)throw new Error(`Headers do not match the template in ${sheet}.`);
    let dataRows=0;
    for (let i = headerRow+1; i < values.length; i++) {
      if (!values[i].some(v => String(v).trim())) continue;
      if (++dataRows>LABEL_WORKBOOK_MAX_ROWS||rows.length>=LABEL_WORKBOOK_TOTAL_ROWS)throw new Error('Worksheet limit: 500 data rows per worksheet and 7000 per workbook. Narrow the selected lists.');
      const fields = Object.fromEntries(columns.map((c, n) => [c, String(values[i][n] ?? '').trim()]));
      if(!newLayout&&headers[definition.columns.length]==='Status')fields.Status=String(values[i][definition.columns.length]??'').trim();
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
      rows.push({ sheet:definition.kind, row: i + 1, values: fields, ...(legacy?{warnings:['Older Criteria headers were converted. Download the current template for the next upload.']}: {}) });
    }
  }
  if(!seen.size)throw new Error('Unknown workbook: no recognised category sheets. Download the System Labels template.');
  return rows;
}

export function systemLabelErrorWorkbook(rows: LabelImportPreviewRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const data = [
    ['Worksheet', 'Row', 'Code', 'Result', 'Message'],
    ...rows.filter(r => r.outcome === 'error'||r.outcome === 'skip').map(r => [safe(r.sheet), r.row, safe(r.values.Code??r.values.Name??''), r.outcome, safe(r.message)]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(data), widths = [24, 8, 38, 12, 88];
  sheet['!cols'] = widths.map(wch => ({ wch }));
  // Reserve space for wrapped identifiers/messages. This is a conservative estimate, not font metrics;
  // all cell text is retained and unusually long rows remain manually expandable in Excel.
  sheet['!rows'] = data.map((row, index) => ({ hpt: index === 0 ? 24 : Math.min(240, Math.max(32,
    8 + 15 * Math.max(...row.map((value, column) => String(value).split(/\r\n|\r|\n/).reduce((lines, line) => lines + Math.max(1, Math.ceil([...line].length / (widths[column] - 4))), 0))),
  )) }));
  XLSX.utils.book_append_sheet(wb, sheet, 'Errors');
  // The installed SheetJS writer serializes widths/heights but not arbitrary cell.s alignment.
  // Its public synchronous ZIP API styles only this freshly generated report, preserving our
  // synchronous caller contract; no uploaded archive or business value is rewritten here.
  const zip = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const part = (name: string): string => {
    // CFB resolves a leading slash relative to its synthetic Root Entry storage.
    const entry = XLSX.CFB.find(zip, '/' + name);
    if (!entry?.content) throw new Error('Error workbook layout is unavailable.');
    return Buffer.from(entry.content).toString('utf8');
  };
  let styles = part('xl/styles.xml');
  const cellXfs = /<cellXfs\b[^>]*\bcount="(\d+)"[^>]*>/.exec(styles);
  if (!cellXfs || !styles.includes('</cellXfs>')) throw new Error('Error workbook styles are unavailable.');
  const first = Number(cellXfs[1]);
  const wrapped = [0, 49].map(numFmtId => `<xf numFmtId="${numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`).join('');
  styles = styles.replace(cellXfs[0], cellXfs[0].replace(/count="\d+"/, `count="${first + 2}"`)).replace('</cellXfs>', wrapped + '</cellXfs>');
  const xml = part('xl/worksheets/sheet1.xml').replace(/<c\b[^>]*>/g, opening => {
    const closed = opening.endsWith('/>'), attributes = opening.slice(2, closed ? -2 : -1).replace(/\s+s="[^"]*"/g, '');
    const address = /\br="([A-Z]+)(\d+)"/.exec(attributes);
    const style = first + (address?.[1] === 'B' && address[2] !== '1' ? 0 : 1);
    return '<c' + attributes + ` s="${style}"` + (closed ? '/>' : '>');
  });
  XLSX.CFB.utils.cfb_add(zip, '/xl/styles.xml', Buffer.from(styles));
  XLSX.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', Buffer.from(xml));
  return new Uint8Array(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip', compression: true }));
}


export function systemLabelExportId(bytes:Buffer):string|null {
  const wb=readWorkbook(bytes);
  const id=wb.Sheets[LABEL_EXPORT_SHEET]?.B2?.v;
  if(id==null)return null;
  if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid export metadata.');
  return id;
}

type LabelWorkbookReferences={companies:string[][];grades:string[][];employees:string[][]};
export type LabelTemplateData={samples:Record<string,Record<string,string>[]>;suggestions?:Partial<Record<string,string[]>>};
const xmlLiteral=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const templateFieldHelp:Record<string,string>={
  Code:'Required new code. Existing codes in this category, in any company, including inactive codes, are skipped. Department Code is its Name; Position Code is its Title.',
  Label:'Display label. Job Grade requires a label. For Division through Category, blank uses Code.',
  Description:'Optional detail, except Cost Centres and Business Units require this name.',
  'Head Employee Code':'Optional active employee from the creation company. Enter the employee code, or the exact code — name shown in Sample. This identifies a person, not Yes/No.',
  Company:'Creation company: exact permitted company name or its ID if the name is ambiguous. This does not automatically include the company in Criteria.',
  Criteria:'companies or global. Global requires a group administrator and leaves Criteria Companies blank.',
  'Criteria Companies':'For companies, enter the complete nonempty list of permitted company names or IDs separated by semicolons. Include the creation company only if it should use this code.',
  Status:'Active or Inactive for new rows only. Blank defaults to Active. Other values are refused. Existing codes never change status through import.',
  Rank:'Whole number. Blank defaults to zero.',
  Name:'Required new Grade Group name. Existing group names are skipped.',
  'Grade Codes':'Existing Active job-grade codes, separated by semicolons. A grade can belong to only one group. Import new grades first in a separate import.',
};
function fictionalSample(kind:string):Record<string,string>{
  if(kind==='grade_groups')return {Name:'(example) New grade group','Grade Codes':'EXAMPLE_GRADE'};
  return {Code:'EXAMPLE_NEW',Label:'(example) New label',Description:'(example) Fictional description',Company:'(example) Your company',Criteria:'companies','Criteria Companies':'(example) Your company','Head Employee Code':'',Rank:'0',Status:'Active'};
}
/** Clean upload sheets and a separate, scoped, literal-only guide. No data sheet is pre-populated. */
export async function buildSystemLabelUploadTemplate(p:LabelTemplateData):Promise<Buffer>{
  const wb=XLSX.utils.book_new();
  const instructions:string[][]=[
    ['System Labels — Upload Template'],
    ['Enter new codes in the blank category sheets from row 3. Keep the note, worksheet names and headers unchanged.'],
    ['Instructions and Sample are reference only and never imported. Empty upload sheets are ignored. Formulas and protected upload sheets are refused.'],
    ['Import adds new codes only. Existing codes in this category, for any company, including inactive codes, are skipped. Other valid new rows can still import after preview.'],
    ['Status accepts Active or Inactive where present; blank means Active. Grade Groups has no Status. Import never updates, restores or deletes existing records.'],
    ['Maximum 5 MB, 500 filled data rows per category and 7000 per workbook. Suggestions do not block typing or saving; the application validates your completed file.'],
    ['Company is creation ownership. Criteria independently controls availability. Division through Category, Job Grade and Grade Groups are tenant-wide shared lists.'],
    ['Sample has up to three permitted current Active rows per category. An (example) row is fictional and appears only when there is no permitted current example.'],
    ['Sample is grey and protected against accidental edits without a password. This is not encryption or a security boundary.'],
    [],['Worksheet','Column','How to complete it'],
  ];
  for(const definition of LABEL_TEMPLATE_DEFINITIONS)for(const [header,field]of definition.columns)instructions.push([definition.sheet,header,templateFieldHelp[field]]);
  const guide=XLSX.utils.aoa_to_sheet(instructions);guide['!cols']=[{wch:25},{wch:25},{wch:110}];
  XLSX.utils.book_append_sheet(wb,guide,'Instructions');
  for(const definition of LABEL_TEMPLATE_DEFINITIONS){
    const ws=XLSX.utils.aoa_to_sheet([[LABEL_TEMPLATE_NOTE],definition.columns.map(([header])=>header)]);
    ws['!cols']=definition.columns.map(([header])=>({wch:header==='Description'||header==='Head (leave approver)'?38:26}));
    for(let row=2;row<LABEL_WORKBOOK_MAX_ROWS+2;row++)for(let col=0;col<definition.columns.length;col++)ws[XLSX.utils.encode_cell({r:row,c:col})]={t:'s',v:'',z:definition.columns[col][1]==='Rank'?'0':'@'};
    ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:LABEL_WORKBOOK_MAX_ROWS+1,c:definition.columns.length-1}});
    ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:definition.columns.length-1}}];
    XLSX.utils.book_append_sheet(wb,ws,definition.sheet);
  }
  const sampleRows:string[][]=[['SAMPLE ONLY – NOT UPLOADED'],['Reference examples only. Enter new codes in the blank category sheets.']];
  for(const definition of LABEL_TEMPLATE_DEFINITIONS){
    const rows=p.samples[definition.kind]??[];
    if(rows.length>3)throw new Error('A Sample category exceeds three examples.');
    sampleRows.push([], [definition.sheet,...((ORGANISATION_LABEL_KINDS as readonly string[]).includes(definition.kind)?['Company-linked: creation ownership and Criteria are independent.']:['Tenant-wide shared list.'])],definition.columns.map(([header])=>header));
    for(const row of rows.length?rows:[fictionalSample(definition.kind)])sampleRows.push(definition.columns.map(([,field])=>safe(row[field]??'')));
  }
  const sample=XLSX.utils.aoa_to_sheet(sampleRows);sample['!cols']=Array.from({length:8},()=>({wch:30}));sample['!protect']={};
  XLSX.utils.book_append_sheet(wb,sample,'Sample');
  const zip=await JSZip.loadAsync(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));
  zip.file('xl/styles.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font><font><color rgb="FF595959"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1"/></xf><xf numFmtId="49" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"><alignment wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  for(let index=0;index<wb.SheetNames.length;index++){
    const name=wb.SheetNames[index],path=`xl/worksheets/sheet${index+1}.xml`,entry=zip.file(path)!;
    let xml=await entry.async('string');const definition=LABEL_TEMPLATE_DEFINITIONS.find(row=>row.sheet===name);
    xml=xml.replace(/<c\b([^>]*?)>/g,(_all,attributes:string)=>{
      const address=/\br="([A-Z]+)(\d+)"/.exec(attributes),text=/\bt="(?:s|str|inlineStr)"/.test(attributes);
      const style=name==='Sample'?3:definition&&address?.[2]==='2'||!definition&&address?.[2]==='1'?2:text?1:0;
      return '<c'+attributes.replace(/\s+s="[^"]*"/g,'')+` s="${style}">`;
    });
    if(definition){
      const view='<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews>';
      xml=xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/,view);
      if(!xml.includes('<sheetViews>'))xml=xml.replace(/(<dimension[^>]*\/>)/,'$1'+view);
      const validations:string[]=[];
      for(let column=0;column<definition.columns.length;column++){
        const field=definition.columns[column][1],suggestions=field==='Status'?['Active','Inactive']:field==='Criteria'?['companies','global']:p.suggestions?.[field]??[];
        const choices=[...new Set(suggestions)].filter(value=>value&&!/[",\r\n]/.test(value));
        // Inline OOXML lists have a 255-character limit. Omit long suggestions rather than truncate identities.
        if(!choices.length||choices.join(',').length>253)continue;
        const col=XLSX.utils.encode_col(column);
        validations.push(`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${col}3:${col}${LABEL_WORKBOOK_MAX_ROWS+2}"><formula1>&quot;${xmlLiteral(choices.join(','))}&quot;</formula1></dataValidation>`);
      }
      const validation=validations.length?`<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`:'';
      const filter=`<autoFilter ref="A2:${XLSX.utils.encode_col(definition.columns.length-1)}${LABEL_WORKBOOK_MAX_ROWS+2}"/>`;
      xml=xml.replace('</sheetData>','</sheetData>'+filter);
      const after=xml.includes('</mergeCells>')?'</mergeCells>':'</autoFilter>';
      xml=xml.replace(after,after+validation);
    }
    zip.file(path,xml);
  }
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  readSystemLabelWorkbook(bytes);
  return bytes;
}
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
    ['Status accepts Active or Inactive for new codes; blank means Active. Archived / Inactive from older exports means Inactive. Grade Groups has no editable status. Removed workbook rows never delete records.'],
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
