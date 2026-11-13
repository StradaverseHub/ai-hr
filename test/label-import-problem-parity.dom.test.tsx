/** Board c074c6b8: the System Labels check screen and its Error Log are built from the same problem lines, so for one
 * fixed preview the cells the table shows equal the rows of the downloaded workbook, in every locale. */
import {describe,expect,it} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import * as XLSX from 'xlsx';
import {ImportProblemTable} from '../components/import-problem-table';
import {importProblemSheetRows} from '../lib/import-problem-workbook';
import {labelImportProblemLines,labelProblemTranslator} from '../lib/system-label-import-problems';
import {systemLabelErrorWorkbook} from '../lib/system-label-workbook';
import {LABEL_LEGACY_HEADERS_WARNING,type LabelImportPreviewRow} from '../lib/system-label-definition';
import {LABEL_LOCALES,labelRootTranslator} from './label-import-translators';

const row=(p:Partial<LabelImportPreviewRow>&Pick<LabelImportPreviewRow,'sheet'|'row'|'values'>):LabelImportPreviewRow=>({outcome:'error',selected:false,message:'SERVER_ENGLISH',before:null,after:{...p.values},...p});
/** One preview as analyse returns it: refused, skipped, unselected and imported rows across categories (out of order). */
const rows:LabelImportPreviewRow[]=[
 row({sheet:'department',row:7,values:{Code:'FIN',Company:'Fictional Co A','Criteria Companies':'Fictional Co B'},reason:'invalidCriteriaCompany',reasonDetail:'companyNotInCriteria',reasonColumn:'Company'}),
 row({sheet:'department',row:4,values:{Code:'OPS','Head Employee Code':'E-404'},reason:'invalidHeadEmployee',reasonDetail:'invalidHeadEmployee',reasonColumn:'Head Employee Code'}),
 row({sheet:'division',row:3,values:{Code:'',Label:'No code'},reason:'required',reasonField:'Code',reasonDetail:'required',reasonColumn:'Code'}),
 row({sheet:'division',row:5,values:{Code:'DIV1','Sort Order':'1.5'},reason:'wholeNumber',reasonDetail:'wholeNumber',reasonColumn:'Sort Order'}),
 row({sheet:'division',row:6,values:{Code:'DIV2'},outcome:'skip',reason:'duplicate',reasonDetail:'duplicate',reasonColumn:'Code'}),
 row({sheet:'grades',row:2,values:{Code:'g1',Label:'Grade'},reason:'invalidGradeCode',reasonDetail:'invalidGradeCode',reasonColumn:'Code'}),
 row({sheet:'grade_groups',row:3,values:{Name:'Fictional group','Grade Codes':'NOPE'},reason:'invalidGradeReferences',reasonDetail:'invalidGradeReferences',reasonColumn:'Grade Codes'}),
 row({sheet:'cost_center',row:9,values:{Code:'=HYPERLINK("x")',Company:'Fictional Co A'},reason:'existing',reasonDetail:'existing',reasonColumn:'Code',warnings:[LABEL_LEGACY_HEADERS_WARNING]}),
 row({sheet:'Notes',row:1,values:{Code:'stray'},reason:'unsupportedCategory',reasonDetail:'unsupportedCategory'}),
 row({sheet:'religion',row:2,values:{Code:'REL'},outcome:'skip',reason:'notSelected',reasonDetail:'notSelected',reasonColumn:'Code'}),
 row({sheet:'division',row:2,values:{Code:'NEW'},outcome:'add',selected:true,message:'Valid new code.'}),
];
const tableCells=()=>{
 const table=screen.getByRole('table');
 return [within(table).getAllByRole('columnheader').map(cell=>cell.textContent??''),
  ...within(table).getAllByRole('row').slice(1).map(tr=>within(tr).getAllByRole('cell').map(cell=>cell.textContent??''))];
};
// The writer guards a formula-like cell with a leading apostrophe in the file only.
const unguard=(cell:string)=>cell.replace(/^'(?=[\s]*[=+\-@\t\r])/,'');

describe('System Labels problem lines: screen equals Error Log',()=>{
 it.each(LABEL_LOCALES)('table cells equal workbook rows in %s',(locale,messages)=>{
  const t=labelRootTranslator(locale,messages),lines=labelImportProblemLines(rows,t);
  expect(lines).toHaveLength(10);
  render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><ImportProblemTable lines={lines}/></NextIntlClientProvider>);
  const shown=tableCells();
  const file=XLSX.utils.sheet_to_json<string[]>(XLSX.read(systemLabelErrorWorkbook(rows,t),{type:'array'}).Sheets.Errors,{header:1,raw:false,defval:''}).map(r=>r.map(String).map(unguard));
  expect(file).toEqual(shown);
  expect(importProblemSheetRows({lines,t:labelProblemTranslator(t)})).toEqual(shown);
  const w=messages.labelsImportWizard,h=messages.importProblems.headers;
  expect(shown[0]).toEqual([h.row,h.category,h.reference,h.field,h.value,h.problem,h.correction,h.stage,h.result]);
  // The shared order (Excel row, then file order; the category column says which worksheet), the real Excel rows,
  // the template's own column captions and this locale's own sentences.
  expect(shown.slice(1).map(r=>r[0])).toEqual(['1','2','2','3','3','4','5','6','7','9']);
  expect(shown[1]).toEqual(['1','Notes','stray','','',w.problem.unsupportedCategory,w.fix.unsupportedCategory,messages.importProblems.stage.check,messages.importProblems.result.refused]);
  expect(shown[3].slice(1,3).concat(shown[3][8])).toEqual([messages.admin.profileOptions.category.religion,'REL',messages.importProblems.result.skipped]);
  expect(shown[4].slice(3,6)).toEqual(['Code','',w.problem.required.replace('{field}',w.fields.Code)]);
  expect(shown[5].slice(1,5)).toEqual([messages.admin.benefitScheme.groupsTitle,'Fictional group','Grades in this group','NOPE']);
  expect(shown[6].slice(1,5)).toEqual([messages.admin.systemLabels.category.department,'OPS','Head (leave approver)','E-404']);
  expect(shown[7].slice(3,6)).toEqual(['Sort Order','1.5',w.problem.wholeNumber]);
  expect(shown[8][8]).toBe(messages.importProblems.result.skipped);
  expect(shown[9]).toEqual(['7',messages.admin.systemLabels.category.department,'FIN','Company','Fictional Co A',w.problem.companyNotInCriteria,w.fix.companyNotInCriteria,messages.importProblems.stage.check,messages.importProblems.result.refused]);
  expect(shown[10][5]).toBe(`${w.problem.existing} ${w.problem.legacyHeaders}`);
  expect(shown.flat().join(' ')).not.toContain('SERVER_ENGLISH');
  expect(shown.flat()).not.toContain('NEW');
 });
 it('says in English exactly what the server found (the sentence the report gave before)',()=>{
  const [, en]=LABEL_LOCALES[0];
  const problems=labelImportProblemLines(rows,labelRootTranslator('en',en)).map(line=>line.problem);
  expect(problems).toContain('Company must be included in Criteria Companies.');
  expect(problems).toContain('Head Employee Code must identify one active employee in the origin company.');
  expect(problems).toContain('Code is required.');
  expect(problems).toContain('Rank and Sort Order must be whole numbers.');
  expect(problems).toContain('Duplicate code in this workbook; only the first valid row can be added.');
  expect(problems).toContain('Grade Code must use uppercase letters, digits or underscores.');
  expect(problems).toContain('Grade Codes must reference existing active grades. Import new grades separately first.');
  expect(problems).toContain('This code already exists in this category. No existing record will be changed. Edit it on the System Labels page. Older Criteria headers were converted. Download the current template for the next upload.');
  expect(problems).toContain('Unsupported label category. This worksheet was not imported.');
  expect(problems).toContain('Valid new code was not selected for this import. No record was created.');
 });
 it('every locale defines a problem and a correction for every check',()=>{
  const keys=(o:object)=>Object.keys(o).sort();
  const [, en]=LABEL_LOCALES[0];
  for(const [locale,messages] of LABEL_LOCALES){
   expect(keys(messages.labelsImportWizard.problem),locale).toEqual(keys(en.labelsImportWizard.problem));
   expect(keys(messages.labelsImportWizard.fix),locale).toEqual(keys(en.labelsImportWizard.fix));
   if(locale!=='en')expect(messages.labelsImportWizard.problem.companyNotInCriteria,locale).not.toBe(en.labelsImportWizard.problem.companyNotInCriteria);
  }
 });
});
