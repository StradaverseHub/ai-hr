/** Home projects the existing workflow owners. It never creates tasks, decisions or capabilities. */
import type {SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {readOwnEmployeeHomeConfiguration} from './employee-home-configuration';
import {listPendingTasks} from './approvals-inbox';
import {listPendingReplacementLeaveTasks} from '../packs/leave/service';
import {pendingStandardFeedbackTaskMetadata,pendingOnehrFeedbackTaskMetadata} from '../packs/performance/service';
import {onboardingAssignedTaskMetadata} from '../packs/lifecycle/service';
import {isModuleEnabled} from './entitlements';
import {todayInKualaLumpur} from '../lib/hr-date';
import {projectHomeAssignedWork,type EmployeeHomeTasks} from '../lib/employee-home-tasks';
import {ASSIGNED_APPROVAL_KINDS,assignedApprovalHref,type AssignedApprovalKind} from '../lib/assigned-approval-focus';

export async function readEmployeeHomeTasks(ctx:SessionContext,employmentId?:string,page?:number):Promise<EmployeeHomeTasks>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 // Selection chooses the company's presentation configuration. Work remains account-grained: a
 // selected own employment must not hide assignments addressed to another of the actor's employments.
 const [configuration,inbox,replacement,standardFeedback,onehrFeedback,onboarding]=await Promise.all([
  readOwnEmployeeHomeConfiguration(ctx,subject.employmentId),
  listPendingTasks(ctx,undefined,{attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims')}),
  listPendingReplacementLeaveTasks(ctx),
  isModuleEnabled(ctx,'performance')?pendingStandardFeedbackTaskMetadata(ctx):Promise.resolve([]),
  isModuleEnabled(ctx,'performance')?pendingOnehrFeedbackTaskMetadata(ctx):Promise.resolve([]),
  isModuleEnabled(ctx,'lifecycle')?onboardingAssignedTaskMetadata(ctx):Promise.resolve([]),
 ]);
 return projectHomeAssignedWork([
  ...inbox.map(row=>ASSIGNED_APPROVAL_KINDS.some(kind=>kind===row.kind)?{...row,linkPath:assignedApprovalHref({kind:row.kind as AssignedApprovalKind,id:row.id})}:
   row.kind==='profile'?{...row,linkPath:`/admin/personnel/profile-changes?requestId=${row.id}&assigned=1#request-${row.id}`}:row),
  ...replacement.map(row=>({id:row.id,kind:'replacementLeave' as const,subjectName:row.employee,createdAt:row.createdAt.toISOString(),linkPath:assignedApprovalHref({kind:'replacementLeave',id:row.id})})),
  ...[...standardFeedback,...onehrFeedback,...onboarding].map(row=>({id:row.id,kind:row.kind,subjectName:row.subjectName,createdAt:row.sourceUpdatedAt.toISOString(),linkPath:row.linkPath,...(row.dueDate?{dueDate:row.dueDate}:{})})),
 ],{employmentId:subject.employmentId,today:todayInKualaLumpur(),page,effortMinutes:configuration.configuration.effortMinutes});
}
