import * as XLSX from 'xlsx';
import {readSpreadsheetArchive} from './spreadsheet-archive';
import {INFORMATION_HEADERS,type InformationImportRow,type InformationOptions} from './information-correction';
import {isCalendarDate} from './calendar-date';
export const INFORMATION_MAX_ROWS=200;
/** Strict worksheet envelope. Formulas and errors never supply correction values, even with cached values. */
export function parseInformationWorkbook(content:Buffer):InformationImportRow[]{
 if(content.length>10485760)throw new Error('Choose an Excel file no larger than 10 MB.');
 readSpreadsheetArchive(content,{maxBytes:10485760,maxExpandedBytes:33554432,maxEntries:128});
 const book=XLSX.read(content,{type:'buffer',cellDates:false,cellFormula:true});
 const sheet=book.Sheets.Corrections;if(!sheet||!sheet['!ref'])throw new Error('Use the Corrections sheet from the Information-Only Correction template.');
 const range=XLSX.utils.decode_range(sheet['!ref']);
 if(range.s.r!==0||range.s.c!==0||range.e.r<1||range.e.r>INFORMATION_MAX_ROWS||range.e.c>=INFORMATION_HEADERS.length)throw new Error('Use the nine-column template with between 1 and 200 employee rows.');
 INFORMATION_HEADERS.forEach((header,c)=>{const cell=sheet[XLSX.utils.encode_cell({r:0,c})];if(cell?.v!==header||cell.f)throw new Error('The template columns changed. Download a new template.');});
 const rows:InformationImportRow[]=[];
 for(let r=1;r<=range.e.r;r++){
  const values:InformationImportRow['values']={},errors:string[]=[];
  for(let c=0;c<INFORMATION_HEADERS.length;c++){
   const header=INFORMATION_HEADERS[c],cell=sheet[XLSX.utils.encode_cell({r,c})];
   if(!cell)continue;
   if(cell.f||cell.t==='e'){errors.push(`${header}: formulas and error cells are not accepted.`);continue;}
   if(cell.v===undefined||String(cell.v).trim()==='')continue;
   if((header==='Employee ID'||header==='Company Code'||header==='New Company Code'||header==='Job Grade')&&cell.t!=='s'){errors.push(`${header}: enter a text code to preserve leading zeros.`);continue;}
   if(header==='Group Join Date'||header==='Join Date'){
    let date=String(cell.v).trim();
    if(cell.t==='n') {const parsed=XLSX.SSF.parse_date_code(Number(cell.v),{date1904:!!book.Workbook?.WBProps?.date1904});date=parsed?`${String(parsed.y).padStart(4,'0')}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`:'';}
    if(!isCalendarDate(date))errors.push(`${header}: use YYYY-MM-DD or an Excel date.`);else values[header]=date;
   }else {const value=String(cell.v).trim();if(value.length>1000)errors.push(`${header}: maximum 1,000 characters.`);else values[header]=value;}
  }
  if(!Object.keys(values).length&&!errors.length)continue;
  const companyCode=values['Company Code']??'',employeeCode=values['Employee ID']??'';
  if(!companyCode)errors.push('Company Code is required.');if(!employeeCode)errors.push('Employee ID is required.');
  if(!values['Correction Reason']||values['Correction Reason']!.length<3)errors.push('Correction Reason must contain at least three characters.');
  rows.push({row:r+1,companyCode,employeeCode,values,errors});
 }
 if(!rows.length)throw new Error('The file has no employee rows.');
 const seen=new Map<string,InformationImportRow[]>();
 for(const row of rows){const key=JSON.stringify([row.companyCode.toUpperCase(),row.employeeCode]);seen.set(key,[...(seen.get(key)??[]),row]);}
 for(const duplicates of seen.values())if(duplicates.length>1)for(const row of duplicates)row.errors.push('This employee appears more than once. Keep one correction row per employee.');
 return rows;
}
export function informationWorkbook(options:InformationOptions):Uint8Array{
 const book=XLSX.utils.book_new();
 const sheet=XLSX.utils.aoa_to_sheet([[...INFORMATION_HEADERS]]);sheet['!cols']=INFORMATION_HEADERS.map(()=>({wch:24}));
 XLSX.utils.book_append_sheet(book,sheet,'Corrections');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
 ['Information-Only Correction'],['One row per existing employee. Maximum 200 rows.'],['Company Code checks the existing company. New Company Code is optional.'],['Employee ID and codes must be text; preserve leading zeros. Employee Name is reference only.'],['Blank correction fields keep existing values. Supply a reason on every row.'],['Dates: YYYY-MM-DD text or actual Excel dates. No formulas.'],['Completed transactions are never recalculated. Future processing may use the corrected information.'],['Use Employment Movement for genuine transfers and operational changes.']]),'Instructions');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Company Code','Company Name'],...options.companies.map(c=>[c.code,c.name])]),'Companies');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Job Grade Code','Job Grade Name'],...options.grades.map(g=>[g.code,g.name])]),'Job Grades');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Employment Type Code'],...options.employmentTypes.map(t=>[t])]),'Employment Types');
 return XLSX.write(book,{type:'array',bookType:'xlsx'});
}
