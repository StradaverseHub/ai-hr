import {personnelMergeGroups} from './lifecycle-v9-personnel-merge-fields';
import type {ProbationTemplate} from './probation-workflow';
export const PROBATION_LETTER_KEYS=['employeeName','employeeCode','companyName','startOn','endOn','outcome','extensionMonths','employeeJobTitle','employeeGrade','businessGroup','businessUnit','division','department','lineManagerName','hodName','pbpName','originalEndOn','reviewPlanMonths','confirmationEffectiveOn','extensionNewEndOn','extensionCount','maxExtensions','signatoryName','signatoryTitle','acknowledgedBy','acknowledgedOn','company.name','company.regNo','company.address','company.color'] as const;
/** Blank, held drafts: business owners supply and publish the actual approved wording. */
export function newProbationLetterTemplate(outcome:ProbationTemplate['outcome'],id:string,name:string):ProbationTemplate{
 return{id,name,module:'probation',type:'Letter',rules:{},hrStep:'before',employeeAck:true,retired:false,versions:[],outcome,unfinished:true,blocks:[{id:'letterhead',type:'letterhead',text:'',section:'main'},{id:'heading',type:'heading',text:'',section:'main'},{id:'body',type:'text',text:'',section:'main'},{id:'hr',type:'signature',text:'',section:'signatures',role:'hr',label:''},{id:'employee',type:'signature',text:'',section:'signatures',role:'employee',label:''}],fields:[],route:{version:1,steps:[{id:'pbp',role:'pbp',kind:'sign',stage:0,holderId:null,required:true},{id:'employee',role:'employee',kind:'acknowledge',stage:1,holderId:null,required:true}]}};
}

/** Exact Personnel registry used only by native converted templates; retained letter aliases keep their original meaning. */
export const PROBATION_NATIVE_PERSONNEL_GROUPS=personnelMergeGroups;
export const PROBATION_NATIVE_PERSONNEL_KEYS=personnelMergeGroups.flatMap(group=>group.fields.map(field=>field.key));
