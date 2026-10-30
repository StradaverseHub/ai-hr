import type { Case, Task } from '../../../lib/lifecycle-v9-model';
export function fictionalV9Case(overrides:Partial<Case>={}):Case {
 return {version:9,id:'fictional-case',number:'OFB9-FICTIONAL',module:'off',revision:1,state:'submitted',facts:{name:'Fictional Employee',employeeNo:'FICTIONAL-001',employmentId:'fictional-employment',personId:'fictional-person',joinDate:'2026-10-01',lastDay:'2026-11-30',noticeDate:'2026-10-30',employeeUserId:'fictional-employee',supervisorUserId:null,pbpUserId:null,taUserId:null,businessGroup:'fictional-group',company:'fictional-company',department:'fictional-department',grade:'',employmentType:'permanent',title:'',caseType:'Resignation'},checklistId:null,checklistName:'',override:'automatic',tasks:[],items:[],documents:[],runs:[],mails:[],files:[],pmChanges:[],log:[],sourceRevision:'fictional-source',submittedAt:'2026-10-30T00:00:00Z',closedAt:null,closedBy:null,closeReason:'',cancelReason:'',revokeDate:'2026-11-30',finalFigures:null,review:null,...overrides};
}
export function fictionalV9Task(id:string):Task {
 return {id,name:id,by:'group',group:'fictional-group',mode:'manual',opens:null,due:0,required:false,documentTemplate:null,documentAction:'signed',opensOn:null,dueOn:'2026-11-30',assignee:null,status:'todo',reason:'',assignmentFailure:null};
}
