import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { buildSystemLabelUploadTemplate, buildSystemLabelWorkbook, readSystemLabelWorkbook } from '../lib/system-label-workbook';
import { LABEL_TEMPLATE_DEFINITIONS, LABEL_TEMPLATE_NOTE } from '../lib/system-label-definition';

const make=()=>buildSystemLabelUploadTemplate({samples:{division:[{Code:'00123',Label:'Live label',Description:'Current example',Status:'Active'}]}});
const rewrite=(wb:XLSX.WorkBook)=>XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer;
describe('Labels clean upload template',()=>{
  it('has exactly twenty-three blank business tabs between Instructions and protected Sample',async()=>{
    const bytes=await make(),wb=XLSX.read(bytes,{type:'buffer',cellStyles:true});
    expect(wb.SheetNames).toEqual(['Instructions',...LABEL_TEMPLATE_DEFINITIONS.map(d=>d.sheet),'Sample']);
    for(const definition of LABEL_TEMPLATE_DEFINITIONS){
      const ws=wb.Sheets[definition.sheet];
      expect(ws.A1.v).toBe(LABEL_TEMPLATE_NOTE);
      expect(XLSX.utils.sheet_to_json<string[]>(ws,{header:1,raw:false,blankrows:false})[1]).toEqual(definition.columns.map(([header])=>header));
      expect(Object.entries(ws).filter(([address,cell])=>!address.startsWith('!')&&XLSX.utils.decode_cell(address).r>=2&&String(cell.v??'').trim())).toEqual([]);
    }
    expect(readSystemLabelWorkbook(bytes)).toEqual([]);
    expect(wb.Sheets.Sample.A1.v).toBe('SAMPLE ONLY – NOT UPLOADED');
    const sample=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Sample,{header:1,raw:false});
    expect(sample.some(row=>row.includes('00123'))).toBe(true);
    expect(sample.filter(row=>row.some(cell=>cell==='(example) New label'||cell==='(example) New grade group'))).toHaveLength(22);
    const zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet25.xml')!.async('string');
    expect(xml).toMatch(/<sheetProtection\b[^>]*sheet="1"/);
    expect(xml).not.toMatch(/password|hashValue|saltValue/);
    expect(xml).toContain('s="3"');
    expect(await zip.file('xl/styles.xml')!.async('string')).toContain('FFE7E6E6');
    const upload=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    expect(upload).not.toContain('sheetProtection');
    expect(upload).toContain('showErrorMessage="0"');
    expect(upload).toContain('sqref="H3:H502"');
    expect(upload).toContain('topLeftCell="A3"');
  });
  it('maps business headers to canonical fields and retains physical row numbers and Status',async()=>{
    const wb=XLSX.read(await make(),{type:'buffer'}),ws=wb.Sheets.Division;
    XLSX.utils.sheet_add_aoa(ws,[['00007','New division','Detail','Inactive']],{origin:'A3'});
    expect(readSystemLabelWorkbook(rewrite(wb))).toEqual([{sheet:'division',row:3,values:{Code:'00007',Label:'New division',Description:'Detail',Status:'Inactive'}}]);
    expect(wb.Sheets['Grade Groups'].A2.v).toBe('Group name');
    expect(wb.Sheets['Grade Groups'].B2.v).toBe('Grades in this group');
  });
  it('ignores reference text as data while refusing formula cells in every ignored sheet',async()=>{
    for(const sheet of ['Instructions','Sample','Reference','_Export']){
      const wb=XLSX.read(await make(),{type:'buffer'});
      if(!wb.Sheets[sheet])XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Reference'],['literal']]),sheet);
      wb.Sheets[sheet].A1={t:'n',v:2,f:'1+1'};
      expect(()=>readSystemLabelWorkbook(rewrite(wb))).toThrow(`Formula in ${sheet}!A1`);
    }
  });
  it('retains the formula refusal on an otherwise admitted protected Sample',async()=>{
    const zip=await JSZip.loadAsync(await make()),entry=zip.file('xl/worksheets/sheet25.xml')!;
    const xml=await entry.async('string');expect(xml).toContain('sheetProtection');
    zip.file(entry.name,xml.replace(/<c r="A1"[^>]*>[\s\S]*?<\/c>/,'<c r="A1"><f>1+1</f><v>2</v></c>'));
    const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    expect(()=>readSystemLabelWorkbook(bytes)).toThrow('Formula in Sample!A1');
  });
  it('refuses duplicate aliases, altered note rows, protected upload sheets, and password-protected Sample',async()=>{
    const original=await make();
    const duplicate=XLSX.read(original,{type:'buffer'});
    XLSX.utils.book_append_sheet(duplicate,XLSX.utils.aoa_to_sheet([['Company','Criteria','Criteria Companies','Code','Label','Description','Head Employee Code']]),'department');
    expect(()=>readSystemLabelWorkbook(rewrite(duplicate))).toThrow('Duplicate label worksheet');
    const changed=XLSX.read(original,{type:'buffer'});changed.Sheets.Division.A1.v='Moved header';
    expect(()=>readSystemLabelWorkbook(rewrite(changed))).toThrow('Headers do not match');
    for(const [path,password]of [['xl/worksheets/sheet2.xml',false],['xl/worksheets/sheet25.xml',true]] as const){
      const zip=await JSZip.loadAsync(original),entry=zip.file(path)!,xml=await entry.async('string');
      zip.file(path,password?xml.replace('<sheetProtection ','<sheetProtection password="1234" '):xml.replace('</sheetData>','</sheetData><sheetProtection sheet="1"/>'));
      const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
      expect(()=>readSystemLabelWorkbook(bytes)).toThrow('Protected Excel workbooks');
    }
  });
  it('accepts a list beyond the template\'s 500 formatted rows, up to the 7000-row workbook allowance',async()=>{
    // Board 2026-11-14: one list may use the whole workbook allowance (production Positions holds 1,349 codes).
    const wb=XLSX.read(await make(),{type:'buffer'});
    XLSX.utils.sheet_add_aoa(wb.Sheets.Division,Array.from({length:1349},(_,index)=>[`C${index}`,'Label','','']),{origin:'A3'});
    expect(readSystemLabelWorkbook(rewrite(wb))).toHaveLength(1349);
    XLSX.utils.sheet_add_aoa(wb.Sheets.Division,Array.from({length:7000-1349+1},(_,index)=>[`D${index}`,'Label','','']),{origin:'A1352'});
    expect(()=>readSystemLabelWorkbook(rewrite(wb))).toThrow('Workbook limit: 7000 data rows');
  });
  it('exports a 1,349-row Positions list that its own importer reads back in full',async()=>{
    // Board 2026-11-14 (production): every Positions export was refused by a 500-row per-list cap.
    const rows=Array.from({length:1349},(_,index)=>({Code:`J${String(index+1).padStart(4,'0')}`,Label:'ACCOUNT ASSISTANT',Description:'ACCOUNT ASSISTANT',Status:'Active'}));
    const bytes=await buildSystemLabelWorkbook({kinds:['position'],includeStatus:true,references:{companies:[],grades:[],employees:[]},rows:{position:rows}});
    const read=readSystemLabelWorkbook(bytes).filter(row=>row.sheet==='position');
    expect(read).toHaveLength(1349);
    expect(read.at(-1)).toMatchObject({row:1350,values:{Code:'J1349',Label:'ACCOUNT ASSISTANT'}});
  });
  it('ignores formatted blank cells far below the entries',async()=>{
    const wb=XLSX.read(await make(),{type:'buffer'}),sheet=wb.Sheets.Division;
    XLSX.utils.sheet_add_aoa(sheet,[['C1','Label','','']],{origin:'A3'});
    sheet.A9000={t:'s',v:''};sheet['!ref']='A1:D9000';
    expect(readSystemLabelWorkbook(rewrite(wb)).filter(row=>row.sheet==='division')).toHaveLength(1);
  });
  it('grants protection only to the worksheet resolved as Sample, never to a guessed ZIP path',async()=>{
    const zip=await JSZip.loadAsync(await make()),entry=zip.file('xl/_rels/workbook.xml.rels')!,xml=await entry.async('string');
    expect(xml).toContain('worksheets/sheet25.xml');expect(xml).toContain('worksheets/sheet2.xml');
    zip.file(entry.name,xml.replace('worksheets/sheet25.xml','worksheets/TEMP.xml').replace('worksheets/sheet2.xml','worksheets/sheet25.xml').replace('worksheets/TEMP.xml','worksheets/sheet2.xml'));
    const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    expect(()=>readSystemLabelWorkbook(bytes)).toThrow('Protected Excel workbooks');
  });
});
