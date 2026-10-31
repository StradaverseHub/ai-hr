import {v9Defaults} from '../../lib/lifecycle-v9-defaults';
import type {Case} from '../../lib/lifecycle-v9-model';
export function v9HtmlWorkspace() {
  const config=v9Defaults();
  for(const checklist of config.checklists)checklist.ownerUserId='fictional-hr';
  return {config,cases:[] as Case[],actor:{id:'fictional-hr',name:'Fictional HR'},canConfigure:true,personnelWritableKeys:[],permissions:{onboarding:true,offboarding:true,administration:true,records:true},options:{users:[{id:'fictional-hr',name:'Fictional HR'}],companies:[{id:'alpha',name:'Fictional Alpha'},{id:'beta',name:'Fictional Beta'}],employees:[],labels:{},leaveTypes:[]}};
}
export function v9HtmlCase(company:string):Case {
  return {version:9,id:company,number:'OFB-'+company,module:'off',revision:1,state:'submitted',facts:{name:'Fictional '+company,employeeNo:'EMP-'+company,employmentId:'employment-'+company,personId:'person-'+company,joinDate:'2026-10-01',lastDay:'2026-10-30',noticeDate:'2026-09-30',employeeUserId:'employee',supervisorUserId:'manager',pbpUserId:'pbp',taUserId:'ta',businessGroup:'group',company,department:'dept',grade:'grade',employmentType:'contract',title:'title',caseType:'Resignation'},checklistId:null,checklistName:'',override:'automatic',tasks:[],items:[],documents:[],runs:[],mails:[],files:[],pmChanges:[],log:[],sourceRevision:'fictional-personnel',submittedAt:'2026-10-01T00:00:00Z',closedAt:null,closedBy:null,closeReason:'',cancelReason:'',revokeDate:'2026-10-30',finalFigures:null,review:null};
}
export {blankCase,defaultConfig,progress} from '../../lib/onboarding-model';
