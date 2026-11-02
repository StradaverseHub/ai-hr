import {validateFieldValue,type Block,type Field,type Document,type Signature} from './lifecycle-v9-model';
import {ProbationError} from './probation-model';
import {signingComplete,type SigningDocument} from './document-signing-model';
export function probationLetterDocument(input:{id:string;name:string;templateId:string;templateVersion:number;blocks:Block[];fields:Field[];merge:Record<string,string>;createdAt:string;signing?:SigningDocument|null}):Document{
 const mergeValues=Object.fromEntries(Object.entries(input.merge).map(([key,value])=>[key,value==null?'':String(value)]));
 if(!mergeValues['company.name']&&mergeValues.companyName)mergeValues['company.name']=mergeValues.companyName;
 const current=input.signing?.actions.filter(a=>a.action==='signed'&&a.contentHash===input.signing!.contentHash&&a.contentRevision===input.signing!.contentRevision).sort((a,b)=>input.signing!.route.steps.findIndex(s=>s.id===a.stepId)-input.signing!.route.steps.findIndex(s=>s.id===b.stepId))??[];
 const signature=(actor:typeof current[number]|undefined):Signature|null=>actor?.signature?{by:{id:actor.actorId,name:actor.actorName},at:actor.at,...actor.signature}:null;
 const employee=current.find(a=>a.role==='employee'),hr=current.find(a=>a.role!=='employee');
 // Acknowledgement values belong to the authenticated signature contribution, never posted HR text.
 mergeValues.acknowledgedBy=employee?.actorName??'';mergeValues.acknowledgedOn=employee?.at??'';
 return{id:input.id,templateId:input.templateId,version:input.templateVersion,name:input.name,status:input.signing&&signingComplete(input.signing,{requiredRoles:input.signing.route.steps.filter(s=>s.required).map(s=>s.role)})?'signed':'draft',blocks:structuredClone(input.blocks),fields:structuredClone(input.fields),values:Object.fromEntries(input.fields.map(f=>[f.id,mergeValues[f.pmKey??f.id]??''])),edits:{},mergeValues,hrSignature:signature(hr),employeeSignature:signature(employee),createdAt:input.createdAt,sentAt:null,hrStep:'before',employeeAck:true,templateType:'Letter'};
}

/** Required and conditional values are checked before freezing an HR-authored letter. */
export function validateProbationLetterFields(fields:Field[],merge:Record<string,string>){
 const values=Object.fromEntries(fields.map(field=>[field.id,merge[field.pmKey??field.id]??'']));
 for(const field of fields){
  if(field.when&&values[field.when.field]!==field.when.value)continue;
  if(field.owner==='pmLocked'&&['acknowledgedBy','acknowledgedOn'].includes(field.pmKey??''))continue;
  const value=values[field.id];validateFieldValue(field,value);
  if(field.required&&(!value.trim()||field.type==='checkbox'&&value!=='true'||field.type==='table'&&JSON.parse(value).length===0))throw new ProbationError('invalid','Complete every required visible letter field before preparation.');
 }
}
