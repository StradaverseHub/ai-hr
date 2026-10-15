import { draftScoringSchema,kpiSettingInputSchema } from './model';
const text=(f:FormData,k:string)=>String(f.get(k)??'').trim();
function number(f:FormData,k:string){const value=text(f,k);if(!value)return null;const n=Number(value);if(!Number.isFinite(n))throw Error('Enter a finite number.');return n;}
export function readSettingScoring(f:FormData,id:string){
 const mechanism=text(f,`${id}.mechanism`),method=text(f,`${id}.method`),multiple=number(f,`${id}.multiple`);
 return draftScoringSchema.parse(mechanism==='A'?{mechanism,method,target:number(f,`${id}.target`),rates:[0,1,2,3,4].map(i=>number(f,`${id}.rate.${i}`))}:{mechanism,method,variant:text(f,`${id}.variant`),threshold:number(f,`${id}.threshold`),target:number(f,`${id}.target`),multiple:multiple==null?null:Math.trunc(multiple),excellence:number(f,`${id}.excellence`)});
}
/** The form, autosave and chat flush use the same draft input contract as the service. */
export function readKpiSettingForm(f:FormData,reviewerEmploymentId:string|null){
 return f.getAll('kpiId').map(String).map(id=>kpiSettingInputSchema.parse({id,title:text(f,`${id}.title`),category:text(f,`${id}.category`),libraryId:text(f,`${id}.libraryId`)||null,description:text(f,`${id}.description`),weightBp:Math.round((number(f,`${id}.weight`)??0)*100),unit:text(f,`${id}.unit`),moderatorEmploymentId:text(f,`${id}.moderator`)||reviewerEmploymentId,approverEmploymentIds:f.getAll(`${id}.approverIds`).map(String),scoring:readSettingScoring(f,id)}));
}
