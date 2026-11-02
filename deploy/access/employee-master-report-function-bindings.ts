/** Exact report and definition actions. Scheduling/delivery retain independent owners
 * and remain prerequisites for complete publication. */
import type {FunctionActionDescriptor} from './function-action-contract';
export const EMPLOYEE_MASTER_REPORT_FUNCTIONS:readonly FunctionActionDescriptor[]=[{
 key:'employeeMasterReports',scope:'company',moduleKey:'workforce',labelKey:'employeeMasterReports.title',kind:'screen',course:'administrative',screenKey:'employeeMasterReports',href:'/reports/employee-master',employeeBearing:true,
 actions:(['view','add','edit','delete']as const).map(operation=>({operation,parentCapability:null,delegationFloorFunction:'app.employee_master_function_current_legacy_allowed',bindings:[
  {owner:'core/employee-master-access.ts',operation:'exact-purpose-before-current-native-field-category-catalogue'},
  {owner:'core/employee-master-reports.ts',operation:'scoped-definition-run-export-and-committed-publication-fence'},
  {owner:'app.employee_master_access_stamp',operation:'actual-principal-report-sharing-and-company-source-stamp'},
 ]})),
}];
export const EMPLOYEE_MASTER_REPORT_DEFAULTS={pure:'app.employee_master_function_legacy_allowed',current:'app.employee_master_function_current_legacy_allowed'}as const;


export const REPORT_CATEGORY_FUNCTIONS:readonly FunctionActionDescriptor[]=
 (['personnel','compensation','identity','bank','statutory','confidential_hr']as const).map(category=>({
  key:'reportCategories.'+category,scope:'company',moduleKey:'workforce',labelKey:'employeeMasterReports.permissions.'+category,
  kind:'native_acl',course:'administrative',screenKey:'employeeMasterReports',href:'/reports/employee-master',employeeBearing:true,
  actions:[{operation:'view',parentCapability:null,delegationFloorFunction:'app.report_category_current',bindings:[
   {owner:'app.pay_formula_category',operation:'actual-current-company-'+category+'-read'},
   {owner:'core/payroll.ts',operation:'scope-narrowed-native-category-resolution'},
   {owner:'core/employee-master-access.ts',operation:'authorized-fields-before-report-output'},
   {owner:'app.pay_formula_trace_access',operation:'exact-stored-formula-read-categories'},
   {owner:'app.report_permission_admit',operation:'actual-role-set-widening-and-data-ceilings'},
  ]}],
 }));
