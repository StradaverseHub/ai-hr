import * as XLSX from 'xlsx';
import {readSpreadsheetArchive} from './spreadsheet-archive';
import {INFORMATION_HEADERS,INFORMATION_HEADERS_V2,type InformationHeader,type InformationImportRow,type InformationOptions} from './information-correction';
import {isCalendarDate} from './calendar-date';
export const INFORMATION_MAX_ROWS=200;
/** Codes are text cells so leading zeros survive. */
const CODE_HEADERS=new Set<InformationHeader>(['Employee ID','Company Code','New Company Code','Job Grade','Business Unit','Department','Position','Direct Superior']);
const DATE_HEADERS=new Set<InformationHeader>(['Group Join Date','Join Date','Contract End Date','Internship End Date','Confirmation Date']);
/** ccd3a65c — each period value travels with its unit; one without the other is refused. */
export const INFORMATION_PERIOD_COLUMNS=[['Probation Period','Probation Period Unit'],['Extended Probation Period','Extended Probation Period Unit'],['Notice Before Confirmation','Notice Before Confirmation Unit'],['Notice After Confirmation','Notice After Confirmation Unit']] as const satisfies readonly (readonly [InformationHeader,InformationHeader])[];
/** Which template a Corrections sheet is, by its exact header row. Version 1 keeps today's behaviour,
 * including ignoring a trailing Business Unit/Parent company column, so an old file never starts writing it. */
function templateVersion(sheet:XLSX.WorkSheet,lastColumn:number):1|2{
 const header=(c:number)=>{const cell=sheet[XLSX.utils.encode_cell({r:0,c})];if(cell?.f)throw new Error('The template columns changed. Download a new template.');return cell?.v;};
 if(header(INFORMATION_HEADERS.length-1)===INFORMATION_HEADERS[INFORMATION_HEADERS.length-1])return 1;
 if(lastColumn!==INFORMATION_HEADERS_V2.length-1||INFORMATION_HEADERS_V2.some((name,c)=>header(c)!==name))throw new Error('The template columns changed. Download a new template.');
 return 2;
}
function cellDate(book:XLSX.WorkBook,cell:XLSX.CellObject){
 if(cell.t==='n'){const parsed=XLSX.SSF.parse_date_code(Number(cell.v),{date1904:!!book.Workbook?.WBProps?.date1904});return parsed?`${String(parsed.y).padStart(4,'0')}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`:'';}
 return String(cell.v).trim();
}
/** Strict worksheet envelope. Formulas and errors never supply correction values, even with cached values. */
export function parseInformationWorkbook(content:Buffer):InformationImportRow[]{return parseInformationWorkbookVersioned(content).rows;}
export function parseInformationWorkbookVersioned(content:Buffer):{version:1|2;rows:InformationImportRow[]}{
 if(content.length>10485760)throw new Error('Choose an Excel file no larger than 10 MB.');
 readSpreadsheetArchive(content,{maxBytes:10485760,maxExpandedBytes:33554432,maxEntries:128});
 const book=XLSX.read(content,{type:'buffer',cellDates:false,cellFormula:true});
 const sheet=book.Sheets.Corrections;if(!sheet||!sheet['!ref'])throw new Error('Use the Corrections sheet from the Information-Only Correction template.');
 const range=XLSX.utils.decode_range(sheet['!ref']);
 if(range.s.r!==0||range.s.c!==0||range.e.r<1||range.e.r>INFORMATION_MAX_ROWS||range.e.c>=INFORMATION_HEADERS_V2.length)throw new Error('Use the Information-Only Correction template with between 1 and 200 employee rows.');
 if(range.e.c<INFORMATION_HEADERS.length-1)throw new Error('The template columns changed. Download a new template.');
 const version=templateVersion(sheet,range.e.c);
 const headers:readonly InformationHeader[]=version===1?INFORMATION_HEADERS:INFORMATION_HEADERS_V2;
 if(version===1&&range.e.c>=INFORMATION_HEADERS.length+2)throw new Error('Use the nine-column template with between 1 and 200 employee rows.');
 headers.forEach((header,c)=>{const cell=sheet[XLSX.utils.encode_cell({r:0,c})];if(cell?.v!==header||cell.f)throw new Error('The template columns changed. Download a new template.');});
 const ignoredColumns:Array<{column:number;field:'businessUnit'|'parentCompany'}>=[];
 if(version===1)for(let c=INFORMATION_HEADERS.length;c<=range.e.c;c++){const cell=sheet[XLSX.utils.encode_cell({r:0,c})],header=String(cell?.v??'');if(cell?.f||!['Business Unit','Parent company','Parent Company'].includes(header))throw new Error('The template columns changed. Download a new template.');const field=header==='Business Unit'?'businessUnit':'parentCompany';if(ignoredColumns.some(column=>column.field===field))throw new Error('The template repeats an organisation column.');ignoredColumns.push({column:c,field});}
 const rows:InformationImportRow[]=[];
 for(let r=1;r<=range.e.r;r++){
  const values:InformationImportRow['values']={},errors:string[]=[];
  for(let c=0;c<headers.length;c++){
   const header=headers[c],cell=sheet[XLSX.utils.encode_cell({r,c})];
   if(!cell)continue;
   if(cell.f||cell.t==='e'){errors.push(`${header}: formulas and error cells are not accepted.`);continue;}
   if(cell.v===undefined||String(cell.v).trim()==='')continue;
   if(CODE_HEADERS.has(header)&&cell.t!=='s'){errors.push(`${header}: enter a text code to preserve leading zeros.`);continue;}
   if(DATE_HEADERS.has(header)){
    const date=cellDate(book,cell);
    if(!isCalendarDate(date))errors.push(`${header}: use YYYY-MM-DD or an Excel date.`);else values[header]=date;
   }else {const value=String(cell.v).trim();if(value.length>1000)errors.push(`${header}: maximum 1,000 characters.`);else values[header]=value;}
  }
  if(version===2)for(const [value,unit] of INFORMATION_PERIOD_COLUMNS)if((values[value]===undefined)!==(values[unit]===undefined)&&!errors.some(error=>error.startsWith(value+':')||error.startsWith(unit+':')))errors.push(`${value}: enter the period and its unit together (${unit}).`);
  const ignoredOrganisation:NonNullable<InformationImportRow['ignoredOrganisation']>={};for(const column of ignoredColumns){const cell=sheet[XLSX.utils.encode_cell({r,c:column.column})];if(cell?.f||cell?.t==='e'){errors.push('Organisation columns cannot contain formulas or error cells.');continue;}const value=String(cell?.v??'').trim();if(value.length>1000)errors.push('Organisation value: maximum 1,000 characters.');else if(value)ignoredOrganisation[column.field]=value;}
  if(!Object.keys(values).length&&!errors.length&&!Object.keys(ignoredOrganisation).length)continue;
  const companyCode=values['Company Code']??'',employeeCode=values['Employee ID']??'';
  if(!companyCode)errors.push('Company Code is required.');if(!employeeCode)errors.push('Employee ID is required.');
  if(!values['Correction Reason']||values['Correction Reason']!.length<3)errors.push('Correction Reason must contain at least three characters.');
  rows.push({row:r+1,companyCode,employeeCode,values,errors,...(Object.keys(ignoredOrganisation).length?{ignoredOrganisation}:{})});
 }
 if(!rows.length)throw new Error('The file has no employee rows.');
 const seen=new Map<string,InformationImportRow[]>();
 for(const row of rows){const key=JSON.stringify([row.companyCode.toUpperCase(),row.employeeCode]);seen.set(key,[...(seen.get(key)??[]),row]);}
 for(const duplicates of seen.values())if(duplicates.length>1)for(const row of duplicates)row.errors.push('This employee appears more than once. Keep one correction row per employee.');
 return {version,rows};
}
const LABEL_CAPTIONS={orgDivision:'Division',orgBranch:'Branch',orgRegion:'Region',orgLine:'Line',orgSection:'Section',orgTeam:'Team',orgBase:'Base',employmentCategory:'Category'} as const;
/** Version 2 template (ccd3a65c): the five facts plus the employment details corrected through their owners. */
export function informationWorkbook(options:InformationOptions):Uint8Array{
 const book=XLSX.utils.book_new();
 const sheet=XLSX.utils.aoa_to_sheet([[...INFORMATION_HEADERS_V2]]);sheet['!cols']=INFORMATION_HEADERS_V2.map(()=>({wch:24}));
 XLSX.utils.book_append_sheet(book,sheet,'Corrections');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
 ['Information-Only Correction'],['One row per existing employee. Maximum 200 rows. One file can correct many fields for many employees.'],['Company Code checks the existing company. New Company Code is optional.'],['Employee ID and codes must be text; preserve leading zeros. Employee Name is reference only.'],['Blank correction fields keep existing values. This template does not clear values. Supply a reason on every row.'],['Dates: YYYY-MM-DD text or actual Excel dates. No formulas.'],['Contract End Date applies to Contract employees and Internship End Date to Intern employees (the type after this correction). Each must be later than the start or join date.'],
 ['Business Unit, Department and Position: use the codes listed for the employee\'s company on the reference sheets. Business Unit is refused where the Group structure sets it.'],['Division to Category: use a value from the Organisation Labels sheet.'],['Periods: enter the number and its unit (Month, Week or Day) together.'],['Direct Superior: the Employee ID of an active employee of the same company.'],
 ['Corrections apply from the day you confirm them. No movement event is added and earlier history keeps its values.'],['Completed transactions are never recalculated. Future processing may use the corrected information.'],
 ['Basic Salary, Tender Resignation Date, Resignation Date and Last Working Date: correct the recorded event with the Movement import, Action "Update".'],['Payment Method: use the Bank and Statutory import.'],['Use Employment Movement for genuine transfers and operational changes.']]),'Instructions');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Company Code','Company Name'],...options.companies.map(c=>[c.code,c.name])]),'Companies');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Job Grade Code','Job Grade Name'],...options.grades.map(g=>[g.code,g.name])]),'Job Grades');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Employment Type Code'],...options.employmentTypes.map(t=>[t])]),'Employment Types');
 const organisation=options.organisation??[];
 for(const [kind,title,column] of [['business_unit','Business Units','Business Unit'],['department','Departments','Department'],['position','Positions','Position']] as const)
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Company Code',`${column} Code`,`${column} Name`],...organisation.filter(row=>row.kind===kind).map(row=>[row.companyCode,row.code,row.name])]),title);
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Column','Value','Label'],...(options.labels??[]).map(row=>[LABEL_CAPTIONS[row.field],row.value,row.label])]),'Organisation Labels');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Period Unit'],['Month'],['Week'],['Day']]),'Period Units');
 return XLSX.write(book,{type:'array',bookType:'xlsx'});
}
