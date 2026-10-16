import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { LABEL_IMPORT_DEFINITIONS } from '../lib/system-label-definition';
import { readSystemLabelWorkbook, systemLabelTemplate, systemLabelErrorWorkbook } from '../lib/system-label-workbook';

const workbook=(sheet:string,rows:unknown[][])=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),sheet);return XLSX.write(wb,{type:'buffer',bookType:'xlsx'}) as Buffer;};
describe('System Labels Excel contract',()=>{
  it('round trips every category and uses each editor’s actual fields',()=>{
    const bytes=systemLabelTemplate({companies:[],grades:[],employees:[]});
    const wb=XLSX.read(bytes,{type:'buffer'});
    expect(wb.SheetNames).toEqual(['Instructions',...LABEL_IMPORT_DEFINITIONS.map(d=>d.kind),'Reference']);
    expect(readSystemLabelWorkbook(bytes)).toEqual([]);
    expect(LABEL_IMPORT_DEFINITIONS.find(d=>d.kind==='department')?.columns).toContain('Head Employee Code');
    expect(LABEL_IMPORT_DEFINITIONS.find(d=>d.kind==='division')?.columns).not.toContain('Company');
    expect(wb.SheetNames).not.toContain('employment_type');
    for(const d of LABEL_IMPORT_DEFINITIONS) {
      const cells=d.columns.map(c=>c==='Rank'||c==='Sort Order'?'2':c);
      const rows=readSystemLabelWorkbook(workbook(d.kind,[d.columns,cells]));
      expect(rows).toEqual([{sheet:d.kind,row:2,values:Object.fromEntries(d.columns.map((c,i)=>[c,cells[i]]))}]);
    }
  });
  it('refuses unknown categories and mismatched headers',()=>{
    expect(()=>readSystemLabelWorkbook(workbook('employment_type',[['Code'],['new']]))).toThrow('Unknown');
    expect(()=>readSystemLabelWorkbook(workbook('division',[['Wrong'],['new']]))).toThrow('Headers');
  });
  it('rejects formulas instead of consuming cached values',()=>{
    const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([['Code','Label','Description','Sort Order'],['SAFE','Safe','','0']]);
    ws.A2={t:'s',v:'SAFE',f:'CONCAT("SA","FE")'};XLSX.utils.book_append_sheet(wb,ws,'division');
    expect(()=>readSystemLabelWorkbook(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))).toThrow('Formula');
  });
  it('rejects oversize, malformed archives and over-limit rows',()=>{
    expect(()=>readSystemLabelWorkbook(Buffer.alloc(750001))).toThrow();
    expect(()=>readSystemLabelWorkbook(Buffer.from('not a workbook'))).toThrow();
    expect(()=>readSystemLabelWorkbook(workbook('division',[['Code','Label','Description','Sort Order'],...Array.from({length:501},(_,i)=>[String(i),'X','',''])]))).toThrow('limit');
  });
  it('exports spreadsheet-safe errors with exact source row references',()=>{
    const bytes=systemLabelErrorWorkbook([{sheet:'division',row:2,values:{Code:'=HYPERLINK("bad")'},before:null,after:{},outcome:'error',message:'=1+1'}]);
    const wb=XLSX.read(bytes,{type:'array'}),rows=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Errors,{header:1});
    expect(rows[1].slice(0,4)).toEqual(['division',2,'error',"'=1+1"]);
    expect(Object.values(wb.Sheets.Errors).some(c=>c?.f)).toBe(false);
  });
});

it('accepts only the bounded previous header generation and converts legacy own/shared to complete explicit companies',()=>{
 const definition=LABEL_IMPORT_DEFINITIONS.find(row=>row.kind==='department')!,headers=definition.columns.map(column=>column==='Criteria'?'Scope':column==='Criteria Companies'?'Shared Companies':column);
 const bytes=workbook('department',[headers,['Origin','shared','Other','CODE','Label','Description','']]);
 const [row]=readSystemLabelWorkbook(bytes);expect(row.values).toMatchObject({Criteria:'companies','Criteria Companies':'Origin;Other'});expect(row.warnings?.length).toBeGreaterThan(0);
 expect(()=>readSystemLabelWorkbook(bytes,{generation:3})).toThrow('Headers');
 expect(()=>readSystemLabelWorkbook(workbook('department',[headers,['Origin','own','Other','CODE','Label','Description','']]))).toThrow('Legacy own');
});
