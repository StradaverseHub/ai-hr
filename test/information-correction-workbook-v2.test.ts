/** ccd3a65c — Information-Only Correction template version 2 and version 1 detection. Pure: no database. */
import {describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {INFORMATION_HEADERS,INFORMATION_HEADERS_V2,type InformationHeader} from '../lib/information-correction';
import {informationWorkbook,parseInformationWorkbook,parseInformationWorkbookVersioned} from '../lib/information-correction-workbook';

function book(headers:readonly string[],rows:unknown[][]){const b=XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet([[...headers],...rows]),'Corrections');return XLSX.write(b,{type:'buffer',bookType:'xlsx'}) as Buffer;}
const v2=(cells:Partial<Record<InformationHeader,unknown>>)=>INFORMATION_HEADERS_V2.map(header=>cells[header]??'');
const base={'Company Code':'DEMO','Employee ID':'00012','Correction Reason':'Keyed in wrong department at hire'} as const;

describe('ccd3a65c Information-Only Correction template version 2',()=>{
 it('reads every new column of a version 2 file and keeps codes as text',()=>{
  const {version,rows}=parseInformationWorkbookVersioned(book(INFORMATION_HEADERS_V2,[v2({...base,'Department':'Human Resources','Section':'Payroll Ops','Probation Period':3,'Probation Period Unit':'Month','Confirmation Date':'2026-12-01','Direct Superior':'00047','Business Unit':'BU-01','Position':'Officer','Notice Before Confirmation':2,'Notice Before Confirmation Unit':'week'})]));
  expect(version).toBe(2);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({row:2,companyCode:'DEMO',employeeCode:'00012',errors:[]});
  expect(rows[0].values).toEqual({...base,'Department':'Human Resources','Section':'Payroll Ops','Probation Period':'3','Probation Period Unit':'Month','Confirmation Date':'2026-12-01','Direct Superior':'00047','Business Unit':'BU-01','Position':'Officer','Notice Before Confirmation':'2','Notice Before Confirmation Unit':'week'});
  expect(rows[0]).not.toHaveProperty('ignoredOrganisation');
 });
 it('accepts an actual Excel date for Confirmation Date',()=>{
  const rows=parseInformationWorkbook(book(INFORMATION_HEADERS_V2,[v2({...base,'Confirmation Date':45658})]));
  expect(rows[0].values['Confirmation Date']).toBe('2025-01-01');
 });
 it('refuses a period without its unit and a unit without its period, naming the column',()=>{
  const rows=parseInformationWorkbook(book(INFORMATION_HEADERS_V2,[v2({...base,'Probation Period':3}),v2({...base,'Employee ID':'00013','Extended Probation Period Unit':'Month'})]));
  expect(rows[0].errors).toEqual(['Probation Period: enter the period and its unit together (Probation Period Unit).']);
  expect(rows[1].errors).toEqual(['Extended Probation Period: enter the period and its unit together (Extended Probation Period Unit).']);
 });
 it('refuses formulas, error cells and numeric codes with the column caption',()=>{
  const content=book(INFORMATION_HEADERS_V2,[v2({...base,'Direct Superior':47})]);
  const b=XLSX.read(content,{type:'buffer'});const sheet=b.Sheets.Corrections;
  sheet[XLSX.utils.encode_cell({r:1,c:INFORMATION_HEADERS_V2.indexOf('Department')})]={t:'s',f:'"Fin"&"ance"',v:'Finance'};
  sheet[XLSX.utils.encode_cell({r:1,c:INFORMATION_HEADERS_V2.indexOf('Branch')})]={t:'e',v:7};
  const rows=parseInformationWorkbook(XLSX.write(b,{type:'buffer',bookType:'xlsx'}));
  expect(rows[0].errors).toEqual(expect.arrayContaining(['Direct Superior: enter a text code to preserve leading zeros.','Department: formulas and error cells are not accepted.','Branch: formulas and error cells are not accepted.']));
  expect(rows[0].values).not.toHaveProperty('Department');
 });
 it('refuses an altered or partial version 2 header row',()=>{
  const changed:string[]=[...INFORMATION_HEADERS_V2];changed[12]='Unit';
  expect(()=>parseInformationWorkbook(book(changed,[v2(base)]))).toThrow('template columns changed');
  expect(()=>parseInformationWorkbook(book(INFORMATION_HEADERS_V2.slice(0,20),[v2(base).slice(0,20)]))).toThrow('template columns changed');
 });
 it('keeps version 1 behaviour: a trailing Business Unit stays ignored and never becomes a correction',()=>{
  const {version,rows}=parseInformationWorkbookVersioned(book([...INFORMATION_HEADERS,'Business Unit'],[['DEMO','00012','','','','','','','Correct record','BU-01']]));
  expect(version).toBe(1);
  expect(rows[0]).toMatchObject({ignoredOrganisation:{businessUnit:'BU-01'},errors:[]});
  expect(rows[0].values).not.toHaveProperty('Business Unit');
 });
 it('builds a version 2 template with reference sheets per company and the owner pointers',()=>{
  const file=informationWorkbook({companies:[{id:'c1',code:'DEMO',name:'Demo Sdn Bhd'}],grades:[{id:'g',code:'G1',name:'Junior'}],employmentTypes:['full_time'],
   organisation:[{companyId:'c1',companyCode:'DEMO',kind:'department',id:'d',code:'Finance',name:'Finance'},{companyId:'c1',companyCode:'DEMO',kind:'business_unit',id:'u',code:'BU-01',name:'Retail'}],
   labels:[{field:'orgBranch',value:'KL',label:'Kuala Lumpur'}]});
  const b=XLSX.read(file,{type:'array'});
  expect(b.SheetNames).toEqual(['Corrections','Instructions','Companies','Job Grades','Employment Types','Business Units','Departments','Positions','Organisation Labels','Period Units']);
  expect(XLSX.utils.sheet_to_json<string[]>(b.Sheets.Corrections,{header:1})[0]).toEqual([...INFORMATION_HEADERS_V2]);
  expect(XLSX.utils.sheet_to_json<string[]>(b.Sheets.Departments,{header:1})).toEqual([['Company Code','Department Code','Department Name'],['DEMO','Finance','Finance']]);
  expect(XLSX.utils.sheet_to_json<string[]>(b.Sheets['Organisation Labels'],{header:1})).toEqual([['Column','Value','Label'],['Branch','KL','Kuala Lumpur']]);
  const instructions=XLSX.utils.sheet_to_json<string[]>(b.Sheets.Instructions,{header:1}).flat().join(' ');
  expect(instructions).toContain('Movement import, Action "Update"');expect(instructions).toContain('Bank and Statutory import');
  // A downloaded template, filled in, parses as version 2.
  XLSX.utils.sheet_add_aoa(b.Sheets.Corrections,[v2({...base,'Branch':'KL'})],{origin:'A2'});
  expect(parseInformationWorkbookVersioned(XLSX.write(b,{type:'buffer',bookType:'xlsx'}))).toMatchObject({version:2,rows:[{values:{'Branch':'KL'},errors:[]}]});
 });
});

/** Board 2026-11-14 (production): a six-employee file whose Text-formatted blank cells made Excel record a sheet
 * hundreds of rows deep was refused as "between 1 and 200 employee rows". Limits now count rows that hold entries. */
async function inflate(content:Buffer,ref:string,blankStyledCells:string[]){
 const zip=await JSZip.loadAsync(content),path='xl/worksheets/sheet1.xml',xml=await zip.file(path)!.async('string');
 const blanks=blankStyledCells.map(at=>`<row r="${/\d+/.exec(at)![0]}"><c r="${at}" s="0"/></row>`).join('');
 zip.file(path,xml.replace(/<dimension ref="[^"]*"\/>/,`<dimension ref="${ref}"/>`).replace('</sheetData>',blanks+'</sheetData>'));
 return zip.generateAsync({type:'nodebuffer'});
}
describe('Information-Only Correction counts rows with entries, not formatted blanks',()=>{
 const six=Array.from({length:6},(_,i)=>v2({...base,'Employee ID':String(15+i).padStart(6,'0'),'Department':'HR'}));
 it('reads six employees from a sheet Excel records as 1,000 rows deep',async()=>{
  const content=await inflate(book(INFORMATION_HEADERS_V2,six),'A1:AZ1000',['B900','AZ1000']);
  expect(XLSX.utils.decode_range(XLSX.read(content,{type:'buffer'}).Sheets.Corrections['!ref']!).e.r).toBeGreaterThan(200);
  const rows=parseInformationWorkbook(content);
  expect(rows.map(row=>row.employeeCode)).toEqual(['000015','000016','000017','000018','000019','000020']);
  expect(rows.every(row=>row.errors.length===0)).toBe(true);
 });
 it('still refuses a 201st employee row, naming the row it reached',()=>{
  const many=Array.from({length:201},(_,i)=>v2({...base,'Employee ID':String(i+1).padStart(6,'0')}));
  expect(()=>parseInformationWorkbook(book(INFORMATION_HEADERS_V2,many))).toThrow('Enter at most 200 employee rows. This file has entries down to row 202');
 });
 it('names a stray entry after the last template column',()=>{
  const b=XLSX.read(book(INFORMATION_HEADERS_V2,six),{type:'buffer'}),sheet=b.Sheets.Corrections,col=INFORMATION_HEADERS_V2.length+1;
  sheet[XLSX.utils.encode_cell({r:3,c:col})]={t:'s',v:'note'};sheet['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:6,c:col}});
  expect(()=>parseInformationWorkbook(XLSX.write(b,{type:'buffer',bookType:'xlsx'}))).toThrow(`entries in column ${XLSX.utils.encode_col(col)}, after the last template column`);
 });
 it('refuses a header-only file as having no employee rows',()=>{
  expect(()=>parseInformationWorkbook(book(INFORMATION_HEADERS_V2,[]))).toThrow('The file has no employee rows.');
 });
});
