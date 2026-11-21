import {createProbationCase,DEFAULT_PROBATION_CONFIG,probationRoute} from '../../lib/probation-model';
import {DEFAULT_PROBATION_FORM} from '../../lib/probation-form';
import type {ProbationCaseView,ProbationPartView,ProbationPersonnel} from '../../packs/probation/service';

/** A fictional six-month Probation case view for DOM tests (every name and code is invented). */
export const fixtureStaff='11111111-1111-4111-8111-111111111111';
export const fixtureManager='22222222-2222-4222-8222-222222222222';
export const fixturePartner='33333333-3333-4333-8333-333333333333';
export function probationCaseFixture(){
 let serial=10;const id=()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`;
 const record=createProbationCase({id:id(),employmentId:id(),companyId:id(),sourceKey:'fictional',startOn:'2026-06-03',endOn:'2026-12-02',months:6,grade:'12',explicitNoProbation:false,config:DEFAULT_PROBATION_CONFIG,nextId:id,isWorking:()=>true})!;
 const holders={employee:fixtureStaff,lm:fixtureManager,hod:null,pbp:fixturePartner,gbs:null};
 const facts:ProbationPersonnel={employmentId:record.employmentId,personId:id(),companyId:record.companyId,employeeName:'Fictional Employee',employeeCode:'EX001',companyName:'Fictional Company',startOn:record.startOn,endOn:record.endOn,grade:'12',gradeId:'grade',currentGradeId:'grade',employmentType:'full_time',probationMonths:6,probationUnit:'month',probationValue:6,explicitNoProbation:false,unknownPeriod:false,confirmationOn:null,resignationOn:null,terminatedOn:null,departmentId:id(),businessUnitId:id(),businessGroupId:id(),businessGroup:'Fictional Group',department:'Fictional Department',businessUnit:'Fictional Unit',title:'Fictional Role',division:null,holders:{employee:fixtureStaff,lm:fixtureManager,hod:null,pbp:fixturePartner}};
 const parts:ProbationPartView[]=record.parts.map(p=>({...p,state:'not_issued',storageRevision:1,contentRevision:1,selfVisible:false,managerVisible:false,canEditEmployee:false,canEditSelfAssessment:false,canEditEmployeeComments:false,canAdjudicateOfflineDecision:false,canEditManager:false,managerIssues:[],employeeIssues:[],allowedCommands:[],signing:null,route:probationRoute(p.type,holders)}));
 const view:ProbationCaseView={sourceMoved:false,runtimeEnabled:true,canRequestDateShift:false,canReconcileDates:false,letterTasks:[],sourceChanged:false,dateAdjustments:[],record:{...record,facts,parts},parts,form:DEFAULT_PROBATION_FORM,roles:['pbp'],files:[],followups:[],outcomes:[],holderNames:{[fixtureStaff]:'Fictional Employee',[fixtureManager]:'Fictional Manager',[fixturePartner]:'Fictional Partner'}};
 return{view,parts,part:(type:1|2|3)=>parts.find(p=>p.type===type)!};
}
