/** Shell declaration metadata, never permission policy. See ADR 2026-11-07-navigation-coverage. */
import {SIDEBAR_AUDIENCE_INVENTORY, ADDITIONAL_ROWS, isCollapsible, PERFORMANCE_ADMIN_ROW, ONBOARDING_NODE, SCOPED_LIFECYCLE_NAVIGATION, type ChildItem} from './shell-inventory';
import {resolveShellNavigation, type ShellNavigationFacts} from './shell-resolver';
import {V9_NAVIGATION, V9_SHARED_NAVIGATION} from '../lifecycle-v9-navigation';
import {modulePackById} from '../../packs/registry';
import {navigationPlacement, type NavigationPlacement} from '../navigation-workspaces';

type Binding = {id:string;sourceOwner:string;sourceKey:string;status:'declared'|'replaced'|'shadowed'};
/** Selectors locate descriptors only. IDs and source keys below are explicit, durable business identities.
 * When a label or address changes, update its selector and ledger snapshot while retaining its ID/sourceKey. */
export const REVIEWED_SHELL_BINDINGS:Readonly<Record<string,Binding>> = {
  "audience/sectionHome/dashboard": {"id": "shell.dashboard", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:dashboard", "status": "declared"},
  "audience/sectionHome/myWorkspace": {"id": "shell.myWorkspace", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myWorkspace", "status": "declared"},
  "audience/sectionHome/myPrivateCases": {"id": "shell.myPrivateCases", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myPrivateCases", "status": "declared"},
  "audience/sectionHome/privateCases": {"id": "shell.privateCases", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:privateCases", "status": "declared"},
  "audience/sectionHome/mySystemTesting": {"id": "shell.mySystemTesting", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:mySystemTesting", "status": "declared"},
  "audience/sectionHome/orgChart": {"id": "shell.orgChart", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:orgChart", "status": "declared"},
  "audience/sectionHome/feedback": {"id": "shell.feedback", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:feedback", "status": "declared"},
  "audience/sectionHome/aiCentre": {"id": "shell.aiCentre", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:aiCentre", "status": "declared"},
  "audience/sectionHome/knowledgeBase": {"id": "shell.knowledgeBase", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:knowledgeBase", "status": "declared"},
  "audience/sectionHome/mobilePreview": {"id": "shell.mobilePreview", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:mobilePreview", "status": "declared"},
  "audience/sectionHome/myLeave/leaveOverview": {"id": "shell.leaveOverview", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveOverview", "status": "declared"},
  "audience/sectionHome/myLeave/leaveHistory": {"id": "shell.leaveHistory", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveHistory", "status": "declared"},
  "audience/sectionHome/myLeave/leaveCreditHistory": {"id": "shell.leaveCreditHistory", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveCreditHistory", "status": "declared"},
  "audience/sectionHome/myLeave/leaveCreditDetails": {"id": "shell.leaveCreditDetails", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveCreditDetails", "status": "declared"},
  "audience/sectionHome/myLeave/leaveDetails": {"id": "shell.leaveDetails", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveDetails", "status": "declared"},
  "audience/sectionHome/myAttendance/attendanceClock": {"id": "shell.attendanceClock", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:attendanceClock", "status": "declared"},
  "audience/sectionHome/myAttendance/attendanceCalendar": {"id": "shell.attendanceCalendar", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:attendanceCalendar", "status": "declared"},
  "audience/sectionHome/myAttendance/attendanceRequest": {"id": "shell.attendanceRequest", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:attendanceRequest", "status": "declared"},
  "audience/sectionHome/myAttendance/planOvertime": {"id": "shell.planOvertime", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:planOvertime", "status": "declared"},
  "audience/sectionHome/myAttendance/myAttendanceRequestStatus": {"id": "shell.myAttendanceRequestStatus", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:myAttendanceRequestStatus", "status": "declared"},
  "audience/sectionHome/performanceTalent": {"id": "shell.performanceTalent", "sourceOwner": "packs/performance/index.ts", "sourceKey": "shell-slot:performanceTalent", "status": "declared"},
  "audience/sectionHome/claims": {"id": "shell.claims", "sourceOwner": "packs/claims/index.ts", "sourceKey": "shell-slot:claims", "status": "declared"},
  "audience/sectionHome/lifecycle": {"id": "shell.retiredAudience.lifecycle", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/sectionHome/lifecycle", "status": "replaced"},
  "audience/manage/myTasks": {"id": "shell.myTasks", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myTasks", "status": "declared"},
  "audience/manage/personnelAdmin": {"id": "shell.personnelAdmin", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:personnelAdmin", "status": "declared"},
  "audience/manage/jobDescriptions": {"id": "shell.jobDescriptions", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:jobDescriptions", "status": "declared"},
  "audience/manage/people": {"id": "shell.people", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:people", "status": "declared"},
  "audience/manage/approvals": {"id": "shell.approvals", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:approvals", "status": "declared"},
  "audience/manage/onboardingV31/newJoiners": {"id": "shell.legacyNewJoiners", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "shell-slot:legacyNewJoiners", "status": "replaced"},
  "audience/manage/onboardingV31/onboardingChecklists": {"id": "shell.legacyOnboardingChecklists", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "shell-slot:legacyOnboardingChecklists", "status": "replaced"},
  "audience/manage/onboardingRequisitions/allOnboardingRequisitions": {"id": "shell.retiredAudience.allOnboardingRequisitions", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "retired-slot:audience/manage/onboardingRequisitions/allOnboardingRequisitions", "status": "replaced"},
  "audience/manage/newJoiners": {"id": "shell.retiredAudience.newJoiners", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/newJoiners", "status": "replaced"},
  "audience/manage/onboardingChecklists": {"id": "shell.retiredAudience.onboardingChecklists", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/onboardingChecklists", "status": "replaced"},
  "audience/manage/v9Leavers": {"id": "shell.retiredAudience.v9Leavers", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9Leavers", "status": "replaced"},
  "audience/manage/v9OffboardingChecklists": {"id": "shell.retiredAudience.v9OffboardingChecklists", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9OffboardingChecklists", "status": "replaced"},
  "audience/manage/v9Templates": {"id": "shell.retiredAudience.v9Templates", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9Templates", "status": "replaced"},
  "audience/manage/v9Workflows": {"id": "shell.retiredAudience.v9Workflows", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9Workflows", "status": "replaced"},
  "audience/manage/v9Settings": {"id": "shell.retiredAudience.v9Settings", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9Settings", "status": "replaced"},
  "audience/manage/v9AssignmentGroups": {"id": "shell.retiredAudience.v9AssignmentGroups", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9AssignmentGroups", "status": "replaced"},
  "audience/manage/v9ModuleAccess": {"id": "shell.retiredAudience.v9ModuleAccess", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/v9ModuleAccess", "status": "replaced"},
  "audience/manage/onboardingOffboarding": {"id": "shell.retiredAudience.onboardingOffboarding", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/onboardingOffboarding", "status": "replaced"},
  "audience/manage/myLifecycle": {"id": "shell.retiredAudience.myLifecycle", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/manage/myLifecycle", "status": "replaced"},
  "audience/manage/teamLeaveTracker": {"id": "shell.teamLeaveTracker", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:teamLeaveTracker", "status": "declared"},
  "audience/manage/myTeam": {"id": "shell.myTeam", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:myTeam", "status": "declared"},
  "audience/manage/performanceAdmin": {"id": "shell.performanceAdmin", "sourceOwner": "packs/performance/index.ts", "sourceKey": "shell-slot:performanceAdmin", "status": "declared"},
  "audience/manage/roster": {"id": "shell.rosterManager", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:rosterManager", "status": "declared"},
  "audience/admin/organization": {"id": "shell.organization", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:organization", "status": "declared"},
  "audience/admin/noticeBoard": {"id": "shell.noticeBoard", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:noticeBoard", "status": "declared"},
  "audience/admin/analytics": {"id": "shell.analytics", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:analytics", "status": "declared"},
  "audience/admin/auditTrail": {"id": "shell.auditTrail", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:auditTrail", "status": "declared"},
  "audience/admin/securityCenter": {"id": "shell.securityCenter", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:securityCenter", "status": "declared"},
  "audience/admin/systemSettings/employeeIdConfig": {"id": "shell.employeeIdConfig", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:employeeIdConfig", "status": "declared"},
  "audience/admin/systemSettings/peopleGeneral": {"id": "shell.peopleGeneral", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:peopleGeneral", "status": "declared"},
  "audience/admin/systemSettings/dashboardCardConfig": {"id": "shell.dashboardCardConfig", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:dashboardCardConfig", "status": "declared"},
  "audience/admin/systemSettings/systemLabels": {"id": "shell.systemLabels", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:systemLabels", "status": "declared"},
  "audience/admin/systemSettings/delegations": {"id": "shell.delegations", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:delegations", "status": "declared"},
  "audience/admin/systemSettings/movementSettings": {"id": "shell.movementSettings", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:movementSettings", "status": "declared"},
  "audience/admin/systemSettings/hiringDefaults": {"id": "shell.hiringDefaults", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:hiringDefaults", "status": "declared"},
  "audience/admin/systemSettings/holidays": {"id": "shell.holidays", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:holidays", "status": "declared"},
  "audience/admin/systemSettings/profileRequestSettings": {"id": "shell.profileRequestSettings", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:profileRequestSettings", "status": "declared"},
  "audience/admin/systemSettings/entra": {"id": "shell.entra", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:entra", "status": "declared"},
  "audience/admin/systemSettings/loginPresentation": {"id": "shell.loginPresentation", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:loginPresentation", "status": "declared"},
  "audience/admin/systemSettings/identityEmail": {"id": "shell.identityEmail", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:identityEmail", "status": "declared"},
  "audience/admin/systemSettings/emailTemplates": {"id": "shell.emailTemplates", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:emailTemplates", "status": "declared"},
  "audience/admin/systemSettings/workflowEmail": {"id": "shell.workflowEmail", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:workflowEmail", "status": "declared"},
  "audience/admin/systemSettings/scheduledActions": {"id": "shell.scheduledActions", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:scheduledActions", "status": "declared"},
  "audience/admin/systemSettings/dataPrivacy": {"id": "shell.dataPrivacy", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:dataPrivacy", "status": "declared"},
  "audience/admin/systemSettings/systemExplorer": {"id": "shell.systemExplorer", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:systemExplorer", "status": "declared"},
  "audience/admin/systemSettings/systemTesting": {"id": "shell.systemTesting", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:systemTesting", "status": "declared"},
  "audience/admin/leaveConfig/leaveAdjustments": {"id": "shell.leaveAdjustments", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveAdjustments", "status": "declared"},
  "audience/admin/leaveConfig/leaveDataImport": {"id": "shell.leaveDataImport", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveDataImport", "status": "declared"},
  "audience/admin/leaveConfig/leaveCredit": {"id": "shell.leaveCredit", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveCredit", "status": "declared"},
  "audience/admin/leaveConfig/employeeLeaveInquiry": {"id": "shell.employeeLeaveInquiry", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:employeeLeaveInquiry", "status": "declared"},
  "audience/admin/leaveConfig/leaveSettings": {"id": "shell.leaveSettings", "sourceOwner": "packs/leave/index.ts", "sourceKey": "shell-slot:leaveSettings", "status": "declared"},
  "audience/admin/attendanceSettings/employeeAttendance": {"id": "shell.employeeAttendance", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:employeeAttendance", "status": "declared"},
  "audience/admin/attendanceSettings/applicationHistory": {"id": "shell.applicationHistory", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:applicationHistory", "status": "declared"},
  "audience/admin/attendanceSettings/attendanceBreakdown": {"id": "shell.attendanceBreakdown", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:attendanceBreakdown", "status": "declared"},
  "audience/admin/attendanceSettings/roster": {"id": "shell.rosterAdministration", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:rosterAdministration", "status": "shadowed"},
  "audience/admin/attendanceSettings/attendanceImport": {"id": "shell.attendanceImport", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:attendanceImport", "status": "declared"},
  "audience/admin/attendanceSettings/cardAssignment": {"id": "shell.cardAssignment", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:cardAssignment", "status": "declared"},
  "audience/admin/attendanceSettings/scheduleAssignment": {"id": "shell.scheduleAssignment", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:scheduleAssignment", "status": "declared"},
  "audience/admin/attendanceSettings/attendanceSettingsPage": {"id": "shell.attendanceSettingsPage", "sourceOwner": "packs/attendance/index.ts", "sourceKey": "shell-slot:attendanceSettingsPage", "status": "declared"},
  "audience/admin/claimsConfig": {"id": "shell.claimsConfig", "sourceOwner": "packs/claims/index.ts", "sourceKey": "shell-slot:claimsConfig", "status": "declared"},
  "audience/admin/lifecycleConfig": {"id": "shell.retiredAudience.lifecycleConfig", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/admin/lifecycleConfig", "status": "replaced"},
  "audience/admin/onboardingSettings": {"id": "shell.retiredAudience.onboardingSettings", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/admin/onboardingSettings", "status": "replaced"},
  "audience/admin/onboardingGroups": {"id": "shell.retiredAudience.onboardingGroups", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/admin/onboardingGroups", "status": "replaced"},
  "audience/admin/onboardingModuleAccess": {"id": "shell.retiredAudience.onboardingModuleAccess", "sourceOwner": "packs/lifecycle/index.ts", "sourceKey": "retired-slot:audience/admin/onboardingModuleAccess", "status": "replaced"},
  "audience/admin/payroll/payrollProcess": {"id": "shell.payrollProcess", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollProcess", "status": "declared"},
  "audience/admin/payroll/payrollTransactions": {"id": "shell.payrollTransactions", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollTransactions", "status": "declared"},
  "audience/admin/payroll/payrollBackPay": {"id": "shell.payrollBackPay", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollBackPay", "status": "declared"},
  "audience/admin/payroll/payrollTransactionView": {"id": "shell.payrollTransactionView", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollTransactionView", "status": "declared"},
  "audience/admin/payroll/payrollIndividualPayslip": {"id": "shell.payrollIndividualPayslip", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollIndividualPayslip", "status": "declared"},
  "audience/admin/payroll/payrollStatutoryAdjustment": {"id": "shell.payrollStatutoryAdjustment", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollStatutoryAdjustment", "status": "declared"},
  "audience/admin/payroll/payrollReconciliation": {"id": "shell.payrollReconciliation", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollReconciliation", "status": "declared"},
  "audience/admin/payroll/payrollStatutoryForms": {"id": "shell.payrollStatutoryForms", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollStatutoryForms", "status": "declared"},
  "audience/admin/payroll/payrollPaymentSubmission": {"id": "shell.payrollPaymentSubmission", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollPaymentSubmission", "status": "declared"},
  "audience/admin/payroll/payrollSettings": {"id": "shell.payrollSettings", "sourceOwner": "packs/payroll/index.ts", "sourceKey": "shell-slot:payrollSettings", "status": "declared"},
  "audience/admin/reports/reportMaster": {"id": "shell.reportMaster", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reportMaster", "status": "declared"},
  "audience/admin/reports/reportAttendance": {"id": "shell.reportAttendance", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reportAttendance", "status": "declared"},
  "audience/admin/reports/reportLeave": {"id": "shell.reportLeave", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reportLeave", "status": "declared"},
  "audience/admin/reports/reportPayroll": {"id": "shell.reportPayroll", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reportPayroll", "status": "declared"},
  "audience/admin/reports/reportClaim": {"id": "shell.reportClaim", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reportClaim", "status": "declared"},
  "audience/admin/reports/reportPerformance": {"id": "shell.reportPerformance", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reportPerformance", "status": "declared"},
  "audience/admin/securityPermissions": {"id": "shell.securityPermissions", "sourceOwner": "lib/security-center-navigation.ts", "sourceKey": "shell-slot:securityPermissions", "status": "declared"},
  "audience/admin/functionAccess": {"id": "shell.functionAccess", "sourceOwner": "lib/security-center-navigation.ts", "sourceKey": "shell-slot:functionAccess", "status": "declared"},
  "audience/admin/createLogin": {"id": "shell.createLogin", "sourceOwner": "lib/security-center-navigation.ts", "sourceKey": "shell-slot:createLogin", "status": "declared"},
  "audience/admin/inviteUser": {"id": "shell.inviteUser", "sourceOwner": "lib/security-center-navigation.ts", "sourceKey": "shell-slot:inviteUser", "status": "declared"},
  "audience/admin/users": {"id": "shell.users", "sourceOwner": "lib/security-center-navigation.ts", "sourceKey": "shell-slot:users", "status": "declared"},
  "audience/admin/passwordPolicy": {"id": "shell.passwordPolicy", "sourceOwner": "lib/security-center-navigation.ts", "sourceKey": "shell-slot:passwordPolicy", "status": "declared"},
  "additional/letterTemplates": {"id": "shell.letterTemplates", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterTemplates", "status": "declared"},
  "additional/letterFields": {"id": "shell.letterFields", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterFields", "status": "declared"},
  "additional/letterGenerate": {"id": "shell.letterGenerate", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterGenerate", "status": "declared"},
  "additional/letterApproval": {"id": "shell.letterApproval", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterApproval", "status": "declared"},
  "additional/letterRegister": {"id": "shell.letterRegister", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterRegister", "status": "declared"},
  "additional/letterReports": {"id": "shell.letterReports", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterReports", "status": "declared"},
  "additional/letterSettings": {"id": "shell.letterSettings", "sourceOwner": "lib/letter-navigation.ts", "sourceKey": "shell-slot:letterSettings", "status": "declared"},
  "additional/profileChanges": {"id": "shell.profileChanges", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:profileChanges", "status": "declared"},
  "additional/myPayslips": {"id": "shell.myPayslips", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myPayslips", "status": "declared"},
  "additional/myLetters": {"id": "shell.myLetters", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myLetters", "status": "declared"},
  "additional/taxRelief": {"id": "shell.taxRelief", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:taxRelief", "status": "declared"},
  "additional/myTp3": {"id": "shell.myTp3", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myTp3", "status": "declared"},
  "additional/myEa": {"id": "shell.myEa", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:myEa", "status": "declared"},
  "additional/reimbursementsDue": {"id": "shell.reimbursementsDue", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reimbursementsDue", "status": "declared"},
  "additional/reports": {"id": "shell.reports", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:reports", "status": "declared"},
  "v9/newJoiners": {"id": "shell.v9NewJoiners", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9NewJoiners", "status": "declared"},
  "v9/onboardingChecklists": {"id": "shell.v9OnboardingChecklists", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9OnboardingChecklists", "status": "declared"},
  "v9/v9Leavers": {"id": "shell.v9V9Leavers", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9Leavers", "status": "declared"},
  "v9/v9OffboardingChecklists": {"id": "shell.v9V9OffboardingChecklists", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9OffboardingChecklists", "status": "declared"},
  "v9/v9Templates": {"id": "shell.v9V9Templates", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9Templates", "status": "declared"},
  "v9/v9Workflows": {"id": "shell.v9V9Workflows", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9Workflows", "status": "declared"},
  "v9/v9Settings": {"id": "shell.v9V9Settings", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9Settings", "status": "declared"},
  "v9/v9AssignmentGroups": {"id": "shell.v9V9AssignmentGroups", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9AssignmentGroups", "status": "declared"},
  "v9/v9ModuleAccess": {"id": "shell.v9V9ModuleAccess", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9V9ModuleAccess", "status": "declared"},
  "v9Shared/v9Tasks": {"id": "shell.v9SharedV9Tasks", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9SharedV9Tasks", "status": "declared"},
  "v9Shared/v9RequestRecords": {"id": "shell.v9SharedV9RequestRecords", "sourceOwner": "lib/lifecycle-v9-navigation.ts", "sourceKey": "shell-slot:v9SharedV9RequestRecords", "status": "declared"},
  "rewards/rewardsReviewing": {"id": "shell.rewardsReviewing", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsReviewing", "status": "declared"},
  "rewards/rewardsAnalytics": {"id": "shell.rewardsAnalytics", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsAnalytics", "status": "declared"},
  "rewards/rewardsApprovalsBoard": {"id": "shell.rewardsApprovalsBoard", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsApprovalsBoard", "status": "declared"},
  "rewards/rewardsRules": {"id": "shell.rewardsRules", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsRules", "status": "declared"},
  "rewards/rewardsReviewCycles": {"id": "shell.rewardsReviewCycles", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsReviewCycles", "status": "declared"},
  "rewards/rewardsSharedConfiguration": {"id": "shell.rewardsSharedConfiguration", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsSharedConfiguration", "status": "declared"},
  "rewards/rewardsSalaryStructures": {"id": "shell.rewardsSalaryStructures", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsSalaryStructures", "status": "declared"},
  "rewards/rewardsBonusMatrices": {"id": "shell.rewardsBonusMatrices", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsBonusMatrices", "status": "declared"},
  "rewards/rewardsPatInputs": {"id": "shell.rewardsPatInputs", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsPatInputs", "status": "declared"},
  "rewards/rewardsAccess": {"id": "shell.rewardsAccess", "sourceOwner": "packs/rewards/index.ts", "sourceKey": "shell-slot:rewardsAccess", "status": "declared"},
  "scoped/probation/probationTracker": {"id": "shell.probationTracker", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationTracker", "status": "declared"},
  "scoped/contracts/contractManagement": {"id": "shell.contractManagement", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:contractManagement", "status": "declared"},
  "scoped/probation/probationSettings": {"id": "shell.probationSettings", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationSettings", "status": "declared"},
  "scoped/probation/probationForms": {"id": "shell.probationForms", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationForms", "status": "declared"},
  "scoped/probation/probationRoutes": {"id": "shell.probationRoutes", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationRoutes", "status": "declared"},
  "scoped/probation/probationWorkflows": {"id": "shell.probationWorkflows", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationWorkflows", "status": "declared"},
  "scoped/probation/probationTemplates": {"id": "shell.probationTemplates", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationTemplates", "status": "declared"},
  "scoped/probation/probationIntake": {"id": "shell.probationIntake", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:probationIntake", "status": "declared"},
  "scoped/contracts/contractIntake": {"id": "shell.contractIntake", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:contractIntake", "status": "declared"},
  "scoped/contracts/contractSettings": {"id": "shell.contractSettings", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:contractSettings", "status": "declared"},
  "scoped/contracts/contractWorkflows": {"id": "shell.contractWorkflows", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:contractWorkflows", "status": "declared"},
  "scoped/contracts/contractTemplates": {"id": "shell.contractTemplates", "sourceOwner": "lib/navigation/shell-inventory.ts", "sourceKey": "shell-slot:contractTemplates", "status": "declared"},
};
export type NavigationDeclaration = Binding & {
 selector:string; declaredHref:string; navigationHref:string; ownedSubpaths:readonly string[];
 exactHref:boolean; disabled:boolean; placement?:NavigationPlacement; descriptor:ChildItem;
};
export type CatalogueIssue={code:string;detail:string};
export type NavigationCatalogue={declarations:NavigationDeclaration[];issues:CatalogueIssue[]};
/** Explicit backlog beyond this bounded shell universe; these are not coverage receipts. */
export const NAVIGATION_COVERAGE_BACKLOG = [
 {id:'nested-submenus',owner:'navigation surface owners',reason:'Immediate in-page submenu/tab registries are not yet composed. Shell ownership prefixes do not prove their usable content.'},
] as const;

export function declaredNavigationCatalogue():NavigationCatalogue {
 const declarations:NavigationDeclaration[]=[],issues:CatalogueIssue[]=[];
 const append=(selector:string,row:ChildItem)=>{
  const binding=REVIEWED_SHELL_BINDINGS[selector];
  if(!binding){issues.push({code:'unmapped-declaration',detail:selector});return;}
  declarations.push({...binding,selector,declaredHref:row.href,navigationHref:row.navigationHref??row.href,
   ownedSubpaths:row.ownedSubpaths??[],exactHref:row.exactHref===true,disabled:row.disabled===true,
   placement:navigationPlacement(row.href),descriptor:row});
 };
 for(const group of SIDEBAR_AUDIENCE_INVENTORY)for(const row of group.items){
  const prefix=`audience/${group.labelKey}`;
  if(isCollapsible(row))for(const child of row.children)append(`${prefix}/${row.labelKey}/${child.labelKey}`,child);
  else append(`${prefix}/${row.labelKey}`,row);
 }
 for(const row of ADDITIONAL_ROWS)append(`additional/${row.labelKey}`,row);
 // The V9 display adapter preserves the canonical descriptor's identity and route ownership.
 for(const row of V9_NAVIGATION)append(`v9/${row.labelKey}`,{...row,icon:ONBOARDING_NODE.icon,exactHref:true,
  ownedSubpaths:'ownedSubpaths' in row?[...row.ownedSubpaths]:undefined});
 for(const row of V9_SHARED_NAVIGATION)append(`v9Shared/${row.labelKey}`,{...row,icon:ONBOARDING_NODE.icon,exactHref:true});
 for(const row of modulePackById('rewards')!.navLinks??[])append(`rewards/${row.labelKey}`,row);
 for(const row of SCOPED_LIFECYCLE_NAVIGATION)append(`scoped/${row.module}/${row.labelKey}`,row);
 for(const key of ['id','sourceKey'] as const){const seen=new Set<string>();for(const row of declarations){
  if(seen.has(row[key]))issues.push({code:`duplicate-${key}`,detail:row[key]});seen.add(row[key]);
 }}
 for(const row of declarations){
  if(!row.sourceOwner||!row.sourceKey)issues.push({code:'missing-provenance',detail:row.id});
  if(!row.placement)issues.push({code:'missing-placement',detail:row.id});
 }
 return {declarations,issues};
}
export type ResolvedCatalogueRow={declaration:NavigationDeclaration;row:ChildItem;navigationHref:string;state:'actionable'|'disabled'|'duplicate';duplicateOf?:string};
/** Calls the canonical resolver exactly once. Binding never decides whether a viewer may see a row. */
export function resolveNavigationCatalogue(facts:ShellNavigationFacts){
 const catalogue=declaredNavigationCatalogue(),resolution=resolveShellNavigation(facts),issues=[...catalogue.issues];
 const rows:ResolvedCatalogueRow[]=[],seen=new Map<string,string>();
 for(const row of resolution.destinations){
  // Performance admin is the one canonical descriptor whose runtime address is substituted after gating.
  const available=catalogue.declarations.filter(d=>d.status!=='replaced');
  const direct=available.filter(d=>d.descriptor===row);
  const candidates=direct.length?direct:available.filter(d=>
   d.descriptor===PERFORMANCE_ADMIN_ROW&&row.labelKey===PERFORMANCE_ADMIN_ROW.labelKey&&row.href===facts.performanceAdminHref ||
   d.declaredHref===row.href&&d.descriptor.labelKey===row.labelKey);
  if(candidates.length!==1){issues.push({code:candidates.length?'ambiguous-runtime-binding':'unmapped-runtime-row',detail:`${row.labelKey}:${row.href}`});continue;}
  const declaration=candidates[0],duplicateOf=seen.get(row.href);
  rows.push({declaration,row,navigationHref:row.navigationHref??row.href,state:row.disabled?'disabled':duplicateOf?'duplicate':'actionable',...(duplicateOf?{duplicateOf}:{})});
  if(!duplicateOf)seen.set(row.href,declaration.id);
 }
 return {...catalogue,issues,rows,resolution};
}
