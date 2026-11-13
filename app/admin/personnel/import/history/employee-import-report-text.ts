/** Item 1859cce0 — wording of one error-report line, shared by the attempt page and its CSV download. */
import {personnelColumnLabel} from '@/lib/personnel-import-contract';
import type {EmployeeImportReportLine} from '@/lib/employee-import-report';

/** The people.importHistory translator (structural, so the page and the route can both pass theirs). */
type Translate={(key:string,values?:Record<string,string|number>):string;has(key:string):boolean};
/** The problem in the viewer's language where its reason is known; otherwise the recorded detail. */
export function employeeImportProblemText(line:EmployeeImportReportLine,t:Translate){
 if(line.outcome==='cancelled')return line.stoppedByRows.length?t('errorReport.cancelledRow',{rows:line.stoppedByRows.join(', ')}):t('errorReport.cancelledRowUnnamed');
 if(line.code?.startsWith('contract.')){const key=`errorReport.contract.${line.code.slice('contract.'.length)}`;if(t.has(key))return t(key);}
 return line.message??'';
}
export function employeeImportColumnText(line:EmployeeImportReportLine,resolve:(key:string,fallback:string)=>string){
 return line.column?personnelColumnLabel(line.column,'employee',resolve):'';
}

