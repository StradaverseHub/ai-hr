import {getTranslations} from 'next-intl/server';
import {readProfileRoutingPolicy,profileApproverCandidates} from '@/core/profile-routing';
import {listCompanies,listDepartments,listJobGrades,listEmployees} from '@/core/read';
import {listBusinessUnits,listCostCenters,listPositions} from '@/core/admin';
import {listAllProfileOptions} from '@/core/profile-options';
import {buildOrgCriteriaSections} from '@/core/org-criteria-form';
import {isGroupAdmin} from '@/lib/authz';
import type {SessionContext} from '@/db/client';
import {ProfileRoutingForm} from './routing-form';
import {saveNamedProfileRoutingAction,previewNamedProfileRoutingAction} from './actions';
export async function ProfileRoutingSetup({session:s}:{session:SessionContext}){
 const te=await getTranslations('essProfile');
 const [companies,departments,grades,positions,costCenters,businessUnits,profileOptions,employees]=await Promise.all([listCompanies(s),listDepartments(s),listJobGrades(s),listPositions(s),listCostCenters(s),listBusinessUnits(s),listAllProfileOptions(s),listEmployees(s)]);
 const [crit,org,employmentType]=await Promise.all([getTranslations('admin.leave.adjustmentsCriteria'),getTranslations('admin.profileOptions.category'),getTranslations('people.wizard.employmentType')]);
 const approverIds=new Set(await profileApproverCandidates(s));
 const sections=buildOrgCriteriaSections({companies,departments,grades,positions,costCenters,businessUnits,profileOptions},{crit,org,employmentType});
 const keys={enabled:'routingEnabled',help:'routingHelp',name:'routingName',approver:'routingApprover',choose:'routingChoose',employees:'routingEmployees',criteriaHelp:'routingCriteriaHelp',remove:'routingRemove',add:'routingAdd',save:'routingSave',preview:'routingPreview',previewFailed:'routingSaveFailed',matched:'routingTypeMatched',missing:'routingTypeMissing',overlapping:'routingOverlapping',ineligible:'routingIneligible',requestTypes:'requestTypes',fields:'fieldRequests',photo:'photoRequests',included:'includedEmployees',excluded:'excludedEmployees',exclusionHelp:'exclusionHelp',search:'routingSearch',unavailable:'unavailableSelection',noApprovers:'noValidApprovers',noMatches:'noMatches',anyApprover:'anyApprover',includedCriteria:'includedCriteria',excludedCriteria:'excludedCriteria',selectAllResults:'selectAllResults',allMatching:'allMatching',explicitEmployees:'explicitEmployees',includeSelected:'includeSelected',excludeSelected:'excludeSelected',explicitlyExcluded:'explicitlyExcluded',notIncluded:'notIncluded',transferCriteriaHelp:'transferCriteriaHelp'};
 return <ProfileRoutingForm policy={readProfileRoutingPolicy(s)} sections={sections} employees={employees.map(employee=>({id:employee.employmentId,label:`${employee.employeeCode} · ${employee.name}`}))} approvers={employees.filter(employee=>approverIds.has(employee.employmentId)).map(employee=>({id:employee.employmentId,label:`${employee.employeeCode} · ${employee.name}`}))} disabled={!isGroupAdmin(s)} action={saveNamedProfileRoutingAction} previewAction={previewNamedProfileRoutingAction} labels={Object.fromEntries(Object.entries(keys).map(([key,value])=>[key,te(value)]))}/>;
}
