import {validateFieldValue,type Block,type Field,type Document,type Signature} from './lifecycle-v9-model';
import {ProbationError} from './probation-model';
import {currentRoundActions,signingComplete,type SigningDocument} from './document-signing-model';
/** The role a signature block names while nobody holds its step yet (L3): never "[Signatory]". */
const SIGNER_ROLE_LABELS:Record<string,string>={employee:'Employee',lm:'Line Manager',superior:'Direct Superior',hod:'Head of Department',pbp:'People Business Partner',gbs:'GBS People Ops',hr:'HR signatory',people:'Authorised signatory'};
export function probationSignerRoleLabel(role:string):string{return SIGNER_ROLE_LABELS[role]??'Authorised signatory';}
/**
 * Merge values a routed letter's unsigned signature block prints (lib/lifecycle-v9-signature-presentation.ts): the
 * person holding the block's Sign step on the letter's frozen route (re-frozen when the letter is generated again), their
 * job title, and the routing, group or role the step was routed to. A signed block prints the signature receipt instead.
 */
export const signerMergeKey=(stepId:string,field:'name'|'title'|'label')=>`signingStep.${stepId}.${field}`;
export function probationLetterDocument(input:{id:string;name:string;templateId:string;templateVersion:number;blocks:Block[];fields:Field[];merge:Record<string,string>;createdAt:string;signing?:SigningDocument|null;signers?:Record<string,{name:string|null;title:string|null;label:string|null;role:string}>}):Document{
 const mergeValues=Object.fromEntries(Object.entries(input.merge).map(([key,value])=>[key,value==null?'':String(value)]));
 if(!mergeValues['company.name']&&mergeValues.companyName)mergeValues['company.name']=mergeValues.companyName;
 const current=input.signing?.actions.filter(a=>a.action==='signed'&&a.contentHash===input.signing!.contentHash&&a.contentRevision===input.signing!.contentRevision).sort((a,b)=>input.signing!.route.steps.findIndex(s=>s.id===a.stepId)-input.signing!.route.steps.findIndex(s=>s.id===b.stepId))??[];
 const signature=(actor:typeof current[number]|undefined):Signature|null=>actor?.signature?{by:{id:actor.actorId,name:actor.actorName},at:actor.at,...actor.signature}:null;
 const employee=current.find(a=>a.role==='employee'),hr=current.find(a=>a.role!=='employee');
 // Acknowledgement values belong to the authenticated signature contribution, never posted HR text.
 mergeValues.acknowledgedBy=employee?.actorName??'';mergeValues.acknowledgedOn=employee?.at??'';
 for(const[stepId,signer] of Object.entries(input.signers??{})){
  if(signer.name)mergeValues[signerMergeKey(stepId,'name')]=signer.name;
  if(signer.title)mergeValues[signerMergeKey(stepId,'title')]=signer.title;
  mergeValues[signerMergeKey(stepId,'label')]=signer.label||probationSignerRoleLabel(signer.role);
 }
 return{id:input.id,templateId:input.templateId,version:input.templateVersion,name:input.name,status:input.signing&&signingComplete(input.signing,{requiredRoles:input.signing.route.steps.filter(s=>s.required).map(s=>s.role)})?'signed':'draft',blocks:structuredClone(input.blocks),fields:structuredClone(input.fields),values:Object.fromEntries(input.fields.map(f=>[f.id,mergeValues[f.pmKey??f.id]??''])),edits:{},mergeValues,hrSignature:signature(hr),employeeSignature:signature(employee),...(input.signing?.routing?{stepSignatures:Object.fromEntries(currentRoundActions(input.signing).filter(a=>a.action==='signed'&&a.signature).map(a=>[a.stepId,signature(a)!]))}:{}),createdAt:input.createdAt,sentAt:null,hrStep:'before',employeeAck:true,templateType:'Letter'};
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
