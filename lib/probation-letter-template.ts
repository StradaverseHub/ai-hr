import type {ProbationTemplate} from './probation-workflow';
export const PROBATION_LETTER_KEYS=['employeeName','employeeCode','companyName','startOn','endOn','outcome','extensionMonths'] as const;
/** Blank, held drafts: business owners supply and publish the actual approved wording. */
export function newProbationLetterTemplate(outcome:ProbationTemplate['outcome'],id:string,name:string):ProbationTemplate{
 return{id,name,module:'probation',type:'Letter',rules:{},hrStep:'before',employeeAck:true,retired:false,versions:[],outcome,unfinished:true,blocks:[{id:'letterhead',type:'letterhead',text:'',section:'main'},{id:'heading',type:'heading',text:'',section:'main'},{id:'body',type:'text',text:'',section:'main'},{id:'hr',type:'signature',text:'',section:'signatures',role:'hr',label:''},{id:'employee',type:'signature',text:'',section:'signatures',role:'employee',label:''}],fields:[],route:{version:1,steps:[{id:'pbp',role:'pbp',kind:'sign',stage:0,holderId:null,required:true},{id:'employee',role:'employee',kind:'acknowledge',stage:1,holderId:null,required:true}]}};
}
