/** One adapter for the facts used by the real preview, builder dry run and protected worker. No pay is projected. */
import type {ContractSharedContext} from './contract-shared-read';
import {contractAutomationPending,type ContractAutomationContext} from '../lib/contract-automation-context';
import type {SigningDocument} from '../lib/document-signing-model';
import type {Routing} from '../lib/automation/routing';

export type ContractContextReferences={
 participants:{id:string;name:string;role:'employee'|'directSuperior'}[];
 groups:ContractAutomationContext['groups'];people:{id:string;personId:string;name:string}[];routings:Routing[];
 fallbackGroupId:string|null;postingApproverGroupId:string|null;documents:SigningDocument[];
};
export function contractSharedAutomationContext(view:Pick<ContractSharedContext,'id'|'companyId'|'source'|'flow'>,refs:ContractContextReferences):ContractAutomationContext{
 const source=view.source;
 return {
  caseId:view.id,companyId:view.companyId,subjectPersonId:source.personId,userPersonIds:Object.fromEntries(refs.people.map(person=>[person.id,person.personId])),
  employeeUserIds:refs.participants.filter(p=>p.role==='employee').map(p=>p.id),superiorUserIds:refs.participants.filter(p=>p.role==='directSuperior').map(p=>p.id),
  employeeName:source.name,employeeCode:source.employeeId,jobTitle:source.designation,company:source.company,businessGroup:source.businessGroup,businessGroupId:source.businessGroupId??null,
  businessUnitId:source.businessUnitId,department:source.department,departmentId:source.departmentId,managerName:source.manager,
  startOn:source.startOn,endOn:source.endOn,contractNumber:source.contractNumber,flow:view.flow,
  fallbackGroupId:refs.fallbackGroupId,postingApproverGroupId:refs.postingApproverGroupId,groups:refs.groups,routings:refs.routings,
  activePeople:refs.people.map(person=>person.id),names:Object.fromEntries(refs.people.map(person=>[person.id,person.name])),pending:contractAutomationPending(refs.documents),
 };
}
