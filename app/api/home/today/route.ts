import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {OwnClockEmploymentUnavailableError} from '@/packs/attendance/service';
import {OwnPayrollSubjectUnavailableError} from '@/packs/payroll/service';
import {readEmployeeHomeToday} from '@/core/employee-home-today';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length!==1||!query.get('employmentId'))return Response.json({error:'invalid'},{status:400,headers});
  const value=await readEmployeeHomeToday(session,query.get('employmentId')!);
  return Response.json({version:1,employmentId:value.employmentId,serverNow:value.serverNow,businessDate:value.businessDate,
   attendanceEnabled:value.attendanceEnabled,payrollEnabled:value.payrollEnabled,
   clock:value.clock?{date:value.clock.date,clockedIn:value.clock.clockedIn,openSince:value.clock.openSince,workedSeconds:value.clock.workedSeconds,
    crossesMidnight:value.clock.crossesMidnight,shift:{code:value.clock.shift.code,start:value.clock.shift.start,end:value.clock.shift.end},
    geofencingRequired:value.clock.geofencingRequired,photoRequired:value.clock.photoRequired}:null,
   dayKind:value.dayKind,leavePresence:value.leavePresence,workLocations:{total:value.workLocations.total,names:[...value.workLocations.names]},
   payday:value.payday?{date:value.payday.date,daysAway:value.payday.daysAway}:null},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:
   error instanceof OwnClockEmploymentUnavailableError||error instanceof OwnPayrollSubjectUnavailableError?'employmentUnavailable':'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
