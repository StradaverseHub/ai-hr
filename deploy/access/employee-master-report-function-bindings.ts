/** Exact report execution/export View. Definition authoring, schedules and delivery
 * retain their independent native owners and are not declared complete here. */
import type {FunctionActionDescriptor} from './function-action-contract';
export const EMPLOYEE_MASTER_REPORT_FUNCTIONS:readonly FunctionActionDescriptor[]=[{
 key:'employeeMasterReports',scope:'company',moduleKey:'workforce',labelKey:'employeeMasterReports.title',kind:'screen',course:'administrative',screenKey:'employeeMasterReports',href:'/reports/employee-master',employeeBearing:true,
 actions:[{operation:'view',parentCapability:null,delegationFloorFunction:'app.employee_master_function_current_legacy_allowed',bindings:[
  {owner:'core/employee-master-access.ts',operation:'exact-purpose-before-current-native-field-category-catalogue'},
  {owner:'core/employee-master-reports.ts',operation:'scoped-definition-run-export-and-committed-publication-fence'},
  {owner:'app.employee_master_access_stamp',operation:'actual-principal-report-sharing-and-company-source-stamp'},
 ]}],
}];
export const EMPLOYEE_MASTER_REPORT_DEFAULTS={pure:'app.employee_master_function_legacy_allowed',current:'app.employee_master_function_current_legacy_allowed'}as const;
