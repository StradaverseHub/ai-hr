import {describe,expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import {adminReportParams,buildAdminReport,findPerformanceAdminItems,performanceAdminAction,type ReportPerson} from '../packs/performance/onehr/admin-report-model';
import {buildAssessmentAdminWorkbook} from '../packs/performance/onehr/admin-report-xlsx';
const person:ReportPerson={name:'Person',code:'EMP-1',group:'Group A',company:'Company A',department:'Finance'};
describe('source admin report outcomes',()=>{
 it('filters outstanding groups after aggregating complete and incomplete people',()=>{
  const report=buildAdminReport({kind:'progress',module:'pm',groupBy:'company',status:'outstanding'},'Cycle',{progress:[{...person,cell:{state:'done',label:'approved',count:1,completed:1}},{...person,name:'Second',cell:{state:'pending',label:'not_submitted',count:1,completed:0}},{...person,company:'Company B',cell:{state:'done',label:'approved',count:1,completed:1}}]});
  expect(report.rows).toEqual([['Company A',1,0,1,2,'50%']]);
 });
 it('counts 360 assessor tasks rather than averaging people or subject review completion',()=>{
  const data={assessors:[{...person,assigned:1,done:1},{...person,name:'Second',assigned:7,done:0},{...person,company:'Complete company',assigned:2,done:2}]};
  expect(buildAdminReport({kind:'progress',module:'f360',groupBy:'company',status:'outstanding'},'Cycle',data).rows).toEqual([['Company A',1,8,'12%']]);
  expect(buildAdminReport({kind:'progress',module:'f360',groupBy:'person',status:'done'},'Cycle',data).rows).toHaveLength(2);
 });
 it('distinguishes missing PBT from zero and preserves the effective group figure provenance',()=>{
  const report=buildAdminReport({kind:'pbt'},'Cycle',{profit:[{group:'A',company:'Missing',achievementPct:null,inherited:false},{group:'A',company:'Zero',achievementPct:0,inherited:false},{group:'A',company:'Inherited',achievementPct:131,inherited:true}]});
  expect(report.rows).toEqual([['A','Missing','','Normal (not entered)','Not entered'],['A','Zero',0,'Below 70%','Company'],['A','Inherited',131,'Above 130%','Business group']]);
 });
 it('retains excluded participants and applies group completion after counting them',()=>{
  const data={participants:[{...person,takingPart:true,reason:'confirmed'},{...person,name:'Other',takingPart:false,reason:'removed'}]};
  expect(buildAdminReport({kind:'participants',status:'outstanding'},'Cycle',data).rows).toEqual([['Group A',1,1,2]]);
  expect(buildAdminReport({kind:'participants',groupBy:'person',status:'done'},'Cycle',data).rows[0]).toContain('Yes');
 });
 it('caps displayed rows while retaining the full result total',()=>{
  const report=buildAdminReport({kind:'participants',groupBy:'person'},'Cycle',{participants:Array.from({length:5001},(_,i)=>({...person,name:`Person ${i}`,takingPart:true,reason:'confirmed'}))});expect(report.rows).toHaveLength(5000);expect(report.total).toBe(5001);
 });
 it('supports only six read tools and rejects hidden scope overrides or invented settings writes',()=>{
  expect(performanceAdminAction.safeParse({tool:'save_setting',args:{key:'minValid',value:1}}).success).toBe(false);
  expect(adminReportParams.safeParse({kind:'progress'}).success).toBe(false);
  expect(adminReportParams.safeParse({kind:'participants',tenantId:'foreign'}).success).toBe(false);
 });
 it('ranks labels over values with source stopwords and plural matching',()=>{
  const items=[{kind:'setting' as const,label:'Other',value:'panel',path:'Settings',href:'/one'},{kind:'setting' as const,label:'Panel target',path:'Settings',href:'/two'}];
  expect(findPerformanceAdminItems(items,'Where are the panels settings?',['setting']).map(r=>r.href)).toEqual(['/two','/one']);expect(findPerformanceAdminItems(items,'unrelated',['setting'])).toEqual([]);
 });
 it('exports workbook values as text without turning employee content into formulas',()=>{
  const report=buildAdminReport({kind:'participants',groupBy:'person'},'Cycle',{participants:[{...person,name:'=HYPERLINK("https://evil.test")',takingPart:true,reason:'confirmed'}]}),book=XLSX.read(buildAssessmentAdminWorkbook(report),{type:'buffer'}),cell=book.Sheets.Report.A4;
  expect(cell.t).toBe('s');expect(cell.f).toBeUndefined();expect(cell.v).toBe('=HYPERLINK("https://evil.test")');
 });
});
