/** Export the same shown grid; source facts and display rules retain their existing owners. */
import type {MyTeamSnapshot} from '@/lib/my-team-types';
import type {ReportData} from '@/lib/report-export';
import {csvSafeCell} from '@/lib/csv';
import {annualText,dateText,formatMyTeamCell,type MyTeamTranslate} from '@/components/my-team/presentation';
export function myTeamReport(snapshot:MyTeamSnapshot,locale:string,t:MyTeamTranslate):ReportData {
 const byId=new Map(snapshot.employees.map(employee=>[employee.employmentId,employee]));
 const rows=snapshot.gridEmploymentIds.flatMap(id=>{
  const employee=byId.get(id);if(!employee)return [];
  const days=new Map(employee.days.map(day=>[day.date,day]));
  return [[employee.name,employee.employeeCode??'',employee.occupation??'',annualText(employee,t),...snapshot.period.gridDates.map(date=>{
   const day=days.get(date);return day?formatMyTeamCell(day,snapshot.query.layers,locale,t,{today:snapshot.today,view:snapshot.query.view}).exportText:'';
  })].map(csvSafeCell)];
 });
 // The Excel serializer is shared with existing reports; protect textual formula-leading cells
 // before either format rather than applying CSV-only protection to an Excel export.
 return {filename:`my-team-${snapshot.period.from}_${snapshot.period.to}`,title:t('title'),columns:[t('employeeName'),t('employeeCode'),t('occupation'),t('leaveBalance'),...snapshot.period.gridDates.map(date=>dateText(date,locale))].map(csvSafeCell),rows,layout:{freeze:4,orientation:'landscape'}};
}
