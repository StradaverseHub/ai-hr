import {describe,expect,it} from 'vitest';
import {
 canEditSigningContent,pendingSigningSteps,recordSigningAction,resendSigningDocument,reviseSigningDocument,signingComplete,signingContentLocked,
 signingContentVisible,signingDocumentOwner,signingSendBack,signingStepAction,signingStepQueue,validateSigningRoute,type SigningDocument,type SigningStep,
} from '../lib/document-signing-model';
import {documentRoutingProblems,documentRoutingSignatureProblems,resolveDocumentRouting,type DocumentRouting,type DocumentRoutingResolveContext} from '../lib/document-signing-routing';
import type {Routing} from '../lib/automation/routing';
import {documentRoutingSchema} from '../lib/document-signing-routing-schema';

/** Pure rules of template-routing documents (lib/document-signing-model.ts) and routing per template version. */
const hash='a'.repeat(64),rules={requiredRoles:[] as string[]},at='2026-11-16T03:00:00Z';
const step=(id:string,kind:SigningStep['kind'],stage:number,holder:string,extra:Partial<SigningStep>={}):SigningStep=>({id,role:id,kind,stage,holderId:holder,holderPersonId:'person-'+holder,required:true,...extra});
function routed(steps:SigningStep[],caseOwnerId:string|null='pbp'):SigningDocument{return{tenantId:'t',companyId:'c',subjectId:'s',subjectType:'probation',contentRevision:1,contentHash:hash,route:{version:1,steps},actions:[],routing:{templateId:'tpl',templateVersion:2,caseOwnerId}};}
const chain=()=>routed([step('review','review',1,'gbs'),step('approve','approve',2,'hod'),step('sign-pbp','sign',3,'pbp'),step('sign-emp','sign',3,'staff')]);
function act(doc:SigningDocument,stepId:string,actor:string,action:'signed'|'returned'|'reviewed'|'approved',comment?:string){
 return recordSigningAction(doc,rules,{id:`${stepId}-${action}-${doc.actions.length}`,actorId:actor,actorPersonId:'person-'+actor,actorName:actor,stepId,revision:doc.contentRevision,hash:doc.contentHash,action,comment,...(action==='signed'?{method:'typed' as const,value:actor,consent:true}:{}),at});
}
const pending=(doc:SigningDocument)=>pendingSigningSteps(doc).map(s=>s.id);

describe('template-routing signing model',()=>{
 it('runs a stage in parallel and moves on only when every step of it is done',()=>{
  let doc=act(act(chain(),'review','gbs','reviewed'),'approve','hod','approved');
  expect(pending(doc)).toEqual(['sign-pbp','sign-emp']);
  doc=act(doc,'sign-emp','staff','signed');expect(pending(doc)).toEqual(['sign-pbp']);expect(signingComplete(doc,rules)).toBe(false);
  doc=act(doc,'sign-pbp','pbp','signed');expect(pending(doc)).toEqual([]);expect(signingComplete(doc,rules)).toBe(true);
 });
 it('records Review and Approve as decisions without a signature and puts them in approval queues',()=>{
  const doc=chain();
  expect(()=>act(doc,'review','gbs','signed')).toThrow('different action');
  const reviewed=act(doc,'review','gbs','reviewed');expect(reviewed.actions[0].signature).toBeNull();
  expect(()=>act(reviewed,'approve','hod','signed')).toThrow('different action');
  expect(doc.route.steps.map(s=>[signingStepAction(doc,s),signingStepQueue(s)])).toEqual([['reviewed','approvals'],['approved','approvals'],['signed','tasks'],['signed','tasks']]);
 });
 it('finds the owner: the flagged step, else the first Review step, else the case owner',()=>{
  expect(signingDocumentOwner(chain())).toEqual({stepId:'review',userId:'gbs'});
  const flagged=chain();flagged.route.steps[2].owner=true;expect(signingDocumentOwner(flagged)).toEqual({stepId:'sign-pbp',userId:'pbp'});
  const twoReviews=routed([step('sign','sign',1,'pbp'),step('late','review',4,'hod'),step('early','review',2,'gbs')]);expect(signingDocumentOwner(twoReviews)).toEqual({stepId:'early',userId:'gbs'});
  expect(signingDocumentOwner(routed([step('sign','sign',1,'staff')],'case-owner'))).toEqual({stepId:null,userId:'case-owner'});
  expect(()=>validateSigningRoute({version:1,steps:[step('a','sign',1,'x',{owner:true}),step('b','sign',1,'y',{owner:true})]},rules)).toThrow('Only one step');
 });
 it('sends back from any step: comment required, every completed step cleared, document held with the owner',()=>{
  let doc=act(act(act(chain(),'review','gbs','reviewed'),'approve','hod','approved'),'sign-emp','staff','signed');
  expect(()=>act(doc,'sign-pbp','pbp','returned','  ')).toThrow('Explain');
  doc=act(doc,'sign-pbp','pbp','returned','The extension length is wrong');
  expect(signingSendBack(doc)?.comment).toBe('The extension length is wrong');
  expect(pending(doc)).toEqual([]);expect(signingComplete(doc,rules)).toBe(false);
  expect(()=>act(doc,'sign-pbp','pbp','signed')).toThrow();
  expect(()=>resendSigningDocument(doc,{id:'r1',actorId:'pbp',actorPersonId:'person-pbp',actorName:'pbp',at})).toThrow('owner');
  const resent=resendSigningDocument(doc,{id:'r1',actorId:'gbs',actorPersonId:'person-gbs',actorName:'gbs',comment:'Corrected',at});
  expect(resent.actions.at(-1)).toMatchObject({action:'resent',stepId:'review',role:'owner',signature:null});
  // The routing restarts from its first stage; earlier decisions and signatures no longer count but stay in history.
  expect(pending(resent)).toEqual(['review']);expect(resent.actions).toHaveLength(5);
  expect(resendSigningDocument(resent,{id:'r1',actorId:'gbs',actorPersonId:'person-gbs',actorName:'gbs',at})).toBe(resent);
  expect(()=>resendSigningDocument(resent,{id:'r2',actorId:'gbs',actorPersonId:'person-gbs',actorName:'gbs',at})).toThrow('sent back');
 });
 it('restarts routing from the first stage when the owner revises the returned content',()=>{
  const returned=act(act(chain(),'review','gbs','reviewed'),'approve','hod','returned','Wrong date');
  expect(canEditSigningContent(returned,'gbs')).toBe(true);expect(canEditSigningContent(returned,'hod')).toBe(false);
  expect(pending(reviseSigningDocument(returned,'b'.repeat(64)))).toEqual(['review']);
 });
 it('lets the owner and the pending Review step edit until the first signature, then locks the content for everyone',()=>{
  const doc=routed([step('review','review',1,'gbs'),step('second-review','review',1,'hod'),step('sign','sign',2,'pbp')],'case-owner');
  expect(canEditSigningContent(doc,'gbs')).toBe(true);expect(canEditSigningContent(doc,'hod')).toBe(true);expect(canEditSigningContent(doc,'pbp')).toBe(false);
  const reviewed=act(act(doc,'review','gbs','reviewed'),'second-review','hod','reviewed');
  expect(canEditSigningContent(reviewed,'hod')).toBe(false);expect(canEditSigningContent(reviewed,'gbs')).toBe(true);expect(signingContentLocked(reviewed)).toBe(false);
  const signed=act(reviewed,'sign','pbp','signed');
  expect(signingContentLocked(signed)).toBe(true);for(const user of['gbs','hod','pbp','case-owner'])expect(canEditSigningContent(signed,user)).toBe(false);
  const plain={...doc,routing:undefined};expect(canEditSigningContent(plain,'gbs')).toBe(false);
 });
 it('shows content when it is your turn, after you acted, to the owner and after release; others see status only',()=>{
  let doc=chain();
  expect(signingContentVisible(doc,'gbs',{released:false})).toBe(true);
  expect(signingContentVisible(doc,'pbp',{released:false})).toBe(false);
  expect(signingContentVisible(doc,'stranger',{released:false})).toBe(false);
  expect(signingContentVisible(doc,'stranger',{released:true})).toBe(true);
  expect(signingContentVisible(doc,null,{released:false})).toBe(false);
  doc=act(act(doc,'review','gbs','reviewed'),'approve','hod','approved');
  expect(signingContentVisible(doc,'hod',{released:false})).toBe(true);
  expect(signingContentVisible(doc,'pbp',{released:false})).toBe(true);
  expect(signingContentVisible({...doc,routing:undefined},'stranger',{released:false})).toBe(true);
 });
});

describe('signing and review routing per template version',()=>{
 const refs={routingExists:(id:string)=>id==='r-bp',groupExists:(id:string)=>id==='g-gbs',personExists:(id:string)=>id==='u-1'};
 const valid:DocumentRouting=[
  {id:'s1',order:1,action:'review',who:{kind:'group',groupId:'g-gbs'},owner:true},
  {id:'s2',order:2,action:'sign',who:{kind:'routing',routingId:'r-bp'},owner:false,pick:'roundRobin'},
  {id:'s3',order:2,action:'sign',who:{kind:'employee'},owner:false},
 ];
 it('accepts an empty routing (today’s behaviour) and a complete one',()=>{
  expect(documentRoutingProblems([],refs)).toEqual([]);expect(documentRoutingProblems(valid,refs)).toEqual([]);
 });
 it('reports missing references, bad orders, two owners and no Sign step',()=>{
  expect(documentRoutingProblems([
   {id:'a',order:0,action:'review',who:{kind:'routing',routingId:'gone'},owner:true},
   {id:'a',order:1,action:'approve',who:{kind:'people',userIds:[]},owner:true},
   {id:'c',order:2,action:'approve',who:{kind:'group',groupId:'gone'},owner:false},
  ],refs)).toEqual([
   'Step 1: needs an order number from 1 to 30.','Step 1: the chosen routing no longer exists.',
   'Step 2: each step needs its own id.','Step 2: choose between 1 and 50 people.',
   'Step 3: the chosen assignment group no longer exists.',
   'At least one step must be a Sign step, or nobody signs the document.','Only one step can own the document. Untick the others.',
  ]);
 });
 it('flags a Sign step with no signature block and a block not linked to a step',()=>{
  const blocks=[{id:'b1',type:'text'},{id:'b2',type:'signature',role:'step:s2'},{id:'b3',type:'signature',role:'hr'},{id:'b4',type:'signature',role:'step:removed'}];
  expect(documentRoutingSignatureProblems(valid,blocks)).toEqual([
   'Sign step 3 has no signature block, so that signature has nowhere to print. Add one in the content.',
   'Signature block 3 is not linked to a signing step.','Signature block 4 is not linked to a signing step.',
  ]);
  expect(documentRoutingSignatureProblems([],blocks)).toEqual([]);
 });
 it('freezes a routing into a route: one person per step, parallel orders, owner, and the fallback group with who it was meant for',()=>{
  const bp:Routing={id:'r-bp',name:'BP by business group',rows:[{match:{businessGroup:['BG1']},assignTo:{kind:'group',groupId:'g-bp'}}]};
  const chosen:string[]=[];
  const ctx:DocumentRoutingResolveContext={employeeUserId:'u-emp',directSuperiorUserId:null,facts:{businessGroup:'BG1'},routing:id=>id===bp.id?bp:null,
   groupMembers:id=>id==='g-bp'?['u-bp1','u-bp2']:id==='g-gbs'?['u-gbs']:null,
   choose:(candidates,rule,group)=>{chosen.push(`${group??'people'}:${rule}`);return rule==='roundRobin'?candidates[candidates.length-1]:candidates[0];},
   fallback:{groupId:'g-gbs',members:['u-gbs']},describe:who=>who.kind==='directSuperior'?'Their Direct Superior':who.kind};
  const {route,unresolved}=resolveDocumentRouting([...valid,{id:'s4',order:3,action:'approve',who:{kind:'directSuperior'},owner:false}],ctx);
  expect(route.steps).toEqual([
   {id:'s1',role:'group:g-gbs',kind:'review',stage:1,holderId:'u-gbs',required:true,owner:true},
   {id:'s2',role:'routing:r-bp',kind:'sign',stage:2,holderId:'u-bp2',required:true},
   {id:'s3',role:'employee',kind:'sign',stage:2,holderId:'u-emp',required:true},
   {id:'s4',role:'lm',kind:'approve',stage:3,holderId:'u-gbs',required:true,meantFor:'Their Direct Superior'},
  ]);
  expect(unresolved).toEqual([{stepId:'s4',meantFor:'Their Direct Superior',reason:'No Direct Superior is recorded.',fallbackGroupId:'g-gbs',holderId:'u-gbs'}]);
  // The employee is a fixed holder (lane F2): only routings, groups, named people and the fallback group are assigned.
  expect(chosen).toEqual(['g-gbs:any','g-bp:roundRobin','g-gbs:any']);
  expect(()=>validateSigningRoute(route,rules)).not.toThrow();
 });
 it('stores only the declared routing shape',()=>{
  // Stored routing ids are uuids; the fixtures above use short ids for readability.
  const stored=valid.map(step=>step.who.kind==='routing'?{...step,who:{kind:'routing' as const,routingId:'0b6f3f8e-4c1a-4f7e-9a51-2d1c9e7b6a10'}}:step);
  expect(documentRoutingSchema.safeParse(stored).success).toBe(true);
  expect(documentRoutingSchema.safeParse([{...valid[0],who:{kind:'role',role:'hr'}}]).success).toBe(false);
  expect(documentRoutingSchema.safeParse([{...valid[0],extra:true}]).success).toBe(false);
  expect(documentRoutingSchema.safeParse([{...valid[1],who:{kind:'routing',routingId:'not-an-id'}}]).success).toBe(false);
 });
 it('leaves a step without a holder when neither the step nor the fallback group resolves',()=>{
  const ctx:DocumentRoutingResolveContext={employeeUserId:null,directSuperiorUserId:null,facts:{},routing:()=>null,groupMembers:()=>null,choose:c=>c[0]??null,fallback:null,describe:()=>'The employee'};
  const {route,unresolved}=resolveDocumentRouting([{id:'e',order:1,action:'sign',who:{kind:'employee'},owner:false}],ctx);
  expect(route.steps[0].holderId).toBeNull();expect(unresolved[0]).toMatchObject({stepId:'e',holderId:null,fallbackGroupId:null});
 });
});
