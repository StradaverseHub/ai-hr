import {describe,it,expect} from 'vitest';
import {resolveLabelAssignment,labelAppliesToCompany,LabelAssignmentError} from '../lib/system-label-assignment';
import {LABEL_IMPORT_DEFINITIONS,LABEL_TEMPLATE_DEFINITIONS} from '../lib/system-label-definition';
import {buildSystemLabelWorkbook,readSystemLabelWorkbook,buildSystemLabelUploadTemplate,systemLabelErrorWorkbook} from '../lib/system-label-workbook';
import * as XLSX from 'xlsx';
const companies=[{id:'a',name:'Example A',writable:true,archived:null},{id:'b',name:'Example B',writable:true,archived:null},{id:'hidden',name:'Private',writable:false,archived:null}];
describe('System Labels assignment intent',()=>{
 // Board c074c6b8: each refusal names its exact check and the column it read, without changing reason or message.
 it.each([
  [{Criteria:'invalid'},'invalidCriteria','invalidCriteria','Criteria','Criteria must be global or companies.'],
  [{Company:'missing'},'invalidCompany','companyNotPermitted','Company','Company is unknown, ambiguous, inactive or outside your administrator scope.'],
  [{'Criteria Companies':'a; missing'},'invalidCompany','companyNotPermitted','Criteria Companies','Company is unknown, ambiguous, inactive or outside your administrator scope.'],
  [{Criteria:'global',Company:'a'},'invalidCriteriaCompany','globalWithCompanies','Company','Global criteria must leave Company and Criteria Companies blank.'],
  [{Criteria:'global','Criteria Companies':'a'},'invalidCriteriaCompany','globalWithCompanies','Criteria Companies','Global criteria must leave Company and Criteria Companies blank.'],
  [{Company:'a','Criteria Companies':'b'},'invalidCriteriaCompany','companyNotInCriteria','Company','Company must be included in Criteria Companies.'],
  [{Criteria:'companies'},'criteriaCompaniesRequired','criteriaCompaniesRequired','Criteria Companies','Choose at least one company for companies criteria.'],
 ] as const)('names the check and column of %j',(values,reason,detail,column,message)=>{
  let thrown:unknown;try{resolveLabelAssignment(values,companies,true);}catch(error){thrown=error;}
  expect(thrown).toBeInstanceOf(LabelAssignmentError);expect(thrown).toMatchObject({reason,detail,column,message});
 });
 it('names the global ownership checks',()=>{
  expect(()=>resolveLabelAssignment({},companies,false)).toThrow(expect.objectContaining({reason:'globalAdminRequired',detail:'globalAdminRequired',column:'Criteria'}));
  expect(()=>resolveLabelAssignment({},[],true)).toThrow(expect.objectContaining({reason:'invalidCompany',detail:'noOwnerCompany',column:'Company'}));
 });
 it('uses all-three-blank as global with deterministic internal ownership',()=>{
  expect(resolveLabelAssignment({},[...companies].reverse(),true)).toEqual({companyId:'a',companyIds:null,criteria:'global'});
  expect(()=>resolveLabelAssignment({},companies,false)).toThrow('group administrator');
  expect(()=>resolveLabelAssignment({},[],true)).toThrow('active permitted company');
 });
 it('keeps Company-only and list-only choices company-specific',()=>{
  expect(resolveLabelAssignment({Company:'Example B'},companies,false)).toEqual({companyId:'b',companyIds:['b'],criteria:'companies'});
  expect(resolveLabelAssignment({'Criteria Companies':' Example B ; a; b '},companies,false)).toEqual({companyId:'a',companyIds:['a','b'],criteria:'companies'});
 });
 it.each([
  {Criteria:'companies'}, {Criteria:'invalid'}, {Criteria:'global',Company:'a'}, {Criteria:'global','Criteria Companies':'a'},
  {Company:'a','Criteria Companies':'b'}, {Company:'missing'}, {Company:'Private'}, {'Criteria Companies':'a; missing'},
 ])('rejects incomplete or conflicting assignment without widening it: %j',values=>{
  expect(()=>resolveLabelAssignment(values,companies,true)).toThrow();
 });
 it('rejects ambiguous and archived companies',()=>{
  expect(()=>resolveLabelAssignment({Company:'Example A'},[...companies,{...companies[1],name:'Example A'}],true)).toThrow('ambiguous');
  expect(()=>resolveLabelAssignment({Company:'a'},[{...companies[0],archived:new Date()}],true)).toThrow('inactive');
 });
 it('offers scoped choices only for an explicit operation company',()=>{
  expect(labelAppliesToCompany(null)).toBe(true);expect(labelAppliesToCompany(['a'])).toBe(false);
  expect(labelAppliesToCompany(['a'],'b')).toBe(false);expect(labelAppliesToCompany(['a'],'a')).toBe(true);
 });
 it('exports all 23 categories with complete common columns and literal text',async()=>{
  expect(LABEL_IMPORT_DEFINITIONS).toHaveLength(23);expect(LABEL_TEMPLATE_DEFINITIONS).toHaveLength(23);
  const rows=Object.fromEntries(LABEL_IMPORT_DEFINITIONS.map(d=>[d.kind,[{Code:d.kind==='grade_groups'?'':'0007',Name:'Fictional group',Label:'=literal',Description:'தமிழ் 中文',Criteria:'companies','Criteria Companies':'Example A',Company:'Example A',Status:'Inactive'}]]));
  const bytes=await buildSystemLabelWorkbook({kinds:LABEL_IMPORT_DEFINITIONS.map(d=>d.kind),rows,includeStatus:true,references:{companies:[],grades:[],employees:[]}});
  const wb=XLSX.read(bytes,{type:'buffer'}),parsed=readSystemLabelWorkbook(bytes);
  expect(parsed).toHaveLength(23);
  for(const d of LABEL_IMPORT_DEFINITIONS){
   const headers=XLSX.utils.sheet_to_json<string[]>(wb.Sheets[d.kind],{header:1})[0];
   for(const column of ['Code','Label','Description','Criteria','Criteria Companies','Company','Status'])expect(headers).toContain(column);
   const row=parsed.find(r=>r.sheet===d.kind)!;expect(row.values.Description).toBe('தமிழ் 中文');
   expect(wb.Sheets[d.kind].A2.t).toBe('s');
  }
  expect(parsed.find(r=>r.sheet==='religion')?.values).toMatchObject({Code:'0007',Label:'=literal'});
 });
 it('keeps Grade Group names visible in errors when common Code is intentionally blank',()=>{
  const bytes=systemLabelErrorWorkbook([{sheet:'grade_groups',row:3,values:{Code:'',Name:'Fictional preserved group'},outcome:'error',message:'Check assignment',before:null,after:{}}]);
  // Board c074c6b8: the Reference column (C) of the shared Error Log carries the group name.
  const wb=XLSX.read(bytes,{type:'buffer'});expect(wb.Sheets.Errors.C1.v).toBe('Reference');expect(wb.Sheets.Errors.C2.v).toBe('Fictional preserved group');
 });
 it('downloads blank upload sheets for all categories with clear global instructions',async()=>{
  const bytes=await buildSystemLabelUploadTemplate({samples:{}}),wb=XLSX.read(bytes,{type:'buffer'});
  expect(JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Instructions,{header:1}))).toContain('Global (All Companies)');
  for(const d of LABEL_TEMPLATE_DEFINITIONS)expect(wb.Sheets[d.sheet]).toBeDefined();
  expect(readSystemLabelWorkbook(bytes)).toEqual([]);
 });
});
