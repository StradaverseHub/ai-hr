import {describe,it,expect} from 'vitest';
import {myTeamReport} from '../app/manage/my-team/export/report';
import {formatMyTeamCell,type MyTeamTranslate} from '../components/my-team/presentation';
import {toCsvReport,toXlsxReport} from '../lib/report-export';
import {parseCsv} from '../lib/csv';
import type {MyTeamDay,MyTeamEmployee,MyTeamSnapshot} from '../lib/my-team-types';
import messages from '../messages/en.json';
const t:MyTeamTranslate=(key,values)=>{let text=String(messages.myTeam[key]);for(const [name,value] of Object.entries(values??{}))text=text.replace(`{${name}}`,String(value));return text;};
const day:MyTeamDay={date:'2026-10-01',roster:{kind:'shift',shiftId:'shift',code:'D',name:'Day',color:null,start:'09:00',end:'18:00',scheduledMinutes:480,isRestDay:false,isOverride:true},attendance:{attendanceId:'punch',status:'present',flag:'late',checkInAt:'09:15:00',checkOutAt:'18:00:00',workedMinutes:465,lateMinutes:15,scheduledMinutes:480,fingerprint:'frozen',reviewed:false},leave:[{requestId:'request',leaveTypeId:'annual',code:'AL',name:'Annual Leave',color:null,status:'pending',session:'PM',days:0.5,fromTime:null,toTime:null}]};
const employee=(id:string,name:string):MyTeamEmployee=>({employmentId:id,name,employeeCode:'@employee',occupation:'=HYPERLINK("x")',companyId:'company',departmentId:null,defaultShift:null,annualAvailable:null,upcomingLeave:[],balances:[],days:[day],weeks:[],today:{checkedIn:true,late:true,absent:false,onLeave:false,halfDayLeave:false,pendingApprovals:true}});
function fixture(view:'week'|'month'='week'):MyTeamSnapshot{return {query:{view,scope:'direct',anchorDate:day.date,companyIds:['company'],search:'',layers:{roster:true,attendance:true,leave:true}},today:day.date,period:{from:day.date,to:day.date,gridDates:[day.date],coveringWeeks:[]},scope:{employmentIds:['shown','hidden'],companies:[],departments:[],canEditRoster:false,canChooseDepartment:false},availability:{roster:'available',attendance:'available',leave:'available'},employees:[employee('hidden','Hidden report'),employee('shown','=SUM(A1)')],gridEmploymentIds:['shown'],todaySummary:{members:2,checkedIn:2,late:2,absent:0,onLeave:0,halfDayLeave:0,pendingApprovals:1},attention:[],actionableApprovals:[]};}
describe('My Team exports share shown grid presentation',()=>{
 it.each(['week','month'] as const)('exports only filtered employees in canonical grid order for %s',view=>{
  const snapshot=fixture(view),report=myTeamReport(snapshot,'en',t);
  expect(report.rows).toHaveLength(1);expect(report.rows[0][0]).toBe("'=SUM(A1)");expect(report.rows.flat().join(' ')).not.toContain('Hidden report');
  expect(report.rows[0][4]).toBe(formatMyTeamCell(day,snapshot.query.layers,'en',t,{today:snapshot.today,view}).exportText);
  expect(report.rows[0][3]).toBe(messages.myTeam.annualUnavailable);
 });
 it('honors all layers off instead of exporting concealed data',()=>{
  const snapshot=fixture();snapshot.query.layers={roster:false,attendance:false,leave:false};
  expect(myTeamReport(snapshot,'en',t).rows[0][4]).toBe('');
 });
 it('protects employee-controlled text in both CSV and Excel without dropping records',()=>{
  const report=myTeamReport(fixture(),'en',t),csv=parseCsv(new TextDecoder().decode(toCsvReport(report).bytes));
  expect(csv).toHaveLength(2);expect(csv[1].slice(0,3)).toEqual(["'=SUM(A1)","'@employee","'=HYPERLINK(\"x\")"]);
  const excel=new TextDecoder().decode(toXlsxReport(report).bytes);
  expect(excel).toContain("'=SUM(A1)");expect(excel).toContain("'@employee");expect(excel).toContain("'=HYPERLINK(&quot;x&quot;)");expect(excel).not.toContain('Hidden report');
 });
 it('returns a header-only grid when the canonical filter matches no employees',()=>{
  const snapshot=fixture();snapshot.gridEmploymentIds=[];expect(myTeamReport(snapshot,'en',t).rows).toEqual([]);
 });
});
