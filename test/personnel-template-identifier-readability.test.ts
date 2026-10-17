import {describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {readFileSync} from 'node:fs';
import {buildXlsx} from '../lib/spreadsheet';
import {employeeTextColumnIndexes,EMPLOYEE_XLSX_COLUMNS} from '../lib/import-template-xlsx';
import {sectionTemplateColumns,sectionTextColumnIndexes} from '../lib/import-sections';
import {personnelImportExclusions,personnelImportExclusionEntries} from '../lib/personnel-import-exclusions';

describe('Personnel workbook defects observed in actual Chrome downloads',()=>{
  it.each(['full','profile','employment'] as const)('%s protects newly identified phone and relationship keys through row 501',async choice=>{
    const columns=choice==='full'?[...EMPLOYEE_XLSX_COLUMNS]:sectionTemplateColumns(choice);
    const keys=choice==='employment'?['direct_superior']:['correspondence_mobile_phone','correspondence_home_phone',...(choice==='full'?['direct_superior']:[])];
    const textColumns=choice==='full'?employeeTextColumnIndexes():sectionTextColumnIndexes(choice);
    const bytes=await buildXlsx(columns,[],{textColumns});
    const ws=XLSX.read(bytes,{type:'array',cellNF:true}).Sheets['Leave Import'];
    for(const key of keys){
      const column=columns.indexOf(key);expect(column,key).toBeGreaterThanOrEqual(0);
      for(const row of [1,500])expect(ws[XLSX.utils.encode_cell({r:row,c:column})]?.z,key+' row '+(row+1)).toBe('@');
    }
  });
  it('serializes explicit readable column widths on both data and guidance sheets',async()=>{
    const bytes=await buildXlsx(['Employee ID','A long Personnel field caption'],[],{
      columnWidths:[18,48],extraSheets:[{name:'Instructions',rows:[['Personnel tab','Field','Why and where to go'],['000123','Age','A long explanation '.repeat(25)]],textColumns:[0],columnWidths:[24,52,110],wrapText:true}],
    });
    const zip=await JSZip.loadAsync(bytes);
    for(const sheet of [1,2]){
      const xml=await zip.file(`xl/worksheets/sheet${sheet}.xml`)!.async('string');
      expect(xml).toContain('<cols>');expect(xml).toContain('customWidth="1"');
    }
    const wb=XLSX.read(bytes,{type:'array',cellStyles:true});
    expect(wb.Sheets['Leave Import']['!cols']?.[1].wch).toBeGreaterThanOrEqual(47);
    expect(wb.Sheets.Instructions['!cols']?.[2].wch).toBeGreaterThanOrEqual(109);
    expect(wb.Sheets.Instructions['!rows']?.[1].hpt).toBeGreaterThan(30);
    const styles=await zip.file('xl/styles.xml')!.async('string');
    expect(styles).toContain('wrapText="1"');expect(styles).toContain('vertical="top"');
    const ws=XLSX.read(bytes,{type:'array',cellNF:true,cellStyles:true}).Sheets.Instructions;
    expect(ws.A2.v).toBe('000123');expect(ws.A2.z).toBe('@');
    // SheetJS CE reads fill styles but does not expose cell alignment. Inspect the actual
    // serialized cell-to-XF binding rather than treating its reader limitation as a product fault.
    const sheetXml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    const xfs=styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    expect(xfs).not.toBeNull();
    const formats=xfs![1].match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)??[];
    for(const cell of ['A2','C2']){
      const tag=sheetXml.match(new RegExp('<c\\b[^>]*\\br="'+cell+'"[^>]*>'))?.[0];
      expect(tag,cell).toBeTruthy();
      const index=Number(tag!.match(/\bs="(\d+)"/)?.[1]);expect(Number.isInteger(index),cell).toBe(true);
      expect(formats[index],cell).toContain('wrapText="1"');
      expect(formats[index],cell).toContain('vertical="top"');
    }
  });
  it('does not call an available Employee ID/email relationship import unavailable',()=>{
    const exclusions=personnelImportExclusions('full');
    expect(exclusions.map(field=>field.id)).not.toContain('employment.direct_superior_and_history.employeecode');
    const messages=JSON.parse(readFileSync(new URL('../messages/en.json',import.meta.url),'utf8'));
    const resolve=(key:string,fallback:string)=>key.split('.').reduce((value,part)=>value?.[part],messages)??fallback;
    const entries=personnelImportExclusionEntries('full',resolve);
    expect(entries.find(entry=>entry.id==='employment.direct_superior_and_history.fullname')).toMatchObject({label:'Direct Superior — displayed name'});
    expect(entries.find(entry=>entry.id==='employment.direct_superior_and_history.fullname')?.reason).toContain('Employee ID or work email');
    expect(entries.find(entry=>entry.id==='employment.direct_superior_and_history.superioremploymentid')).toMatchObject({label:'Direct Superior — Personnel record selector'});
    expect(entries.find(entry=>entry.id==='employment.direct_superior_and_history.superioremploymentid')?.reason).toContain('Employee ID or work email');
  });
  it.each(['en','ms','zh','ta','th','vi'])('%s section fence no longer claims all statutory fields are forbidden',locale=>{
    const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));
    expect(messages.people.import.sectionInstructionFence).not.toMatch(/EPF|SOCSO|EIS/);
    expect(sectionTemplateColumns('bank_statutory')).toContain('epf_number');
    expect(sectionTemplateColumns('bank_statutory')).toContain('socso_number');
  });
});
