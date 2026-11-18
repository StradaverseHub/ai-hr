import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import * as M from '../lib/lifecycle-v9-model';
import {v9SigningCanonicalText} from '../lib/lifecycle-v9-document-routing';
import {fictionalV9Case,fictionalV9Task} from './fixtures/lifecycle-v9/case';
function fixture(){
 let sequence=0;const c=fictionalV9Case(),source={'employee.name':'Official employee',address:'',mobile:''};
 const env:M.Environment={today:'2026-11-18',now:'2026-11-18T02:00:00Z',actor:{id:'hr',name:'Fictional HR'},nextId:()=>String(++sequence),onLeave:()=>false,openLoad:()=>0,lastAssigned:()=>0,eligibleUser:()=>true,userName:id=>id,mergeValues:source,signatoryUserId:'hr',personnelCompletion:{country:'MY',source,fingerprint:(values,country)=>createHash('sha256').update(v9SigningCanonicalText({values,country})).digest('hex')}};
 const fields:M.Field[]=[{id:'F51',label:'Address',type:'textarea',owner:'pmLocked',pmKey:'address',required:true,sensitive:false,options:[],section:'main',when:null},{id:'official',label:'Name',type:'text',owner:'pmLocked',pmKey:'employee.name',required:true,sensitive:false,options:[],section:'main',when:null}];
 const template:M.Template={id:'form',name:'Fictional completion form',module:'off',type:'Form',hrStep:'before',employeeAck:false,retired:false,rules:{},versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'text',type:'text',text:'Address: {address}',section:'main'},{id:'fields',type:'fields',text:'',section:'main'}],fields}]};
 const workflow:M.Workflow={id:'release',name:'Release',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],description:'',steps:[{id:'doc',type:'doc',template:'form',release:true}]};
 const config:M.Config={version:9,revision:1,templates:[template],workflows:[workflow],emails:[],groups:[],peopleOpsGroup:null,checklists:[]};
 c.tasks=[{...fictionalV9Task('sent'),documentTemplate:'form',documentAction:'sent'}];return {c,env,source,config,workflow};
}
it('opens unsigned employee preparation without sent task completion, then requires answers before the first HR signature and preserves the signed snapshot',()=>{
 const {c,env,config,workflow,source}=fixture();M.runWorkflow(c,config,workflow,env,'submitted');const doc=c.documents[0];
 expect(doc.personnelCompletion?.preparation).toEqual({at:env.now,by:env.actor});expect(doc.sentAt).toBeNull();expect(doc.status).toBe('draft');expect(c.tasks[0].status).toBe('todo');expect(c.runs[0].status).toBe('waiting');
 const signature={method:'typed' as const,value:'Fictional HR',consent:true,by:env.actor,at:env.now};expect(()=>M.signDocument(c,config,doc.id,'hr',signature,env)).toThrow('required');
 const own={...env,actor:{id:'fictional-employee',name:'Fictional employee'}};M.saveDocument(c,doc.id,{F51:'Employee supplied address'},'employee',own);M.submitDocumentPersonnelCompletion(c,doc.id,own);
 expect(c.pmChanges).toMatchObject([{field:'address',before:'',after:'Employee supplied address',status:'proposed',provenance:{by:own.actor}}]);M.submitDocumentPersonnelCompletion(c,doc.id,own);expect(c.pmChanges).toHaveLength(1);
 M.signDocument(c,config,doc.id,'hr',signature,env);const frozen=structuredClone(doc);source.address='Later official PM address';expect(M.refreshDocumentPersonnelCompletion(doc,env)).toBe(false);expect(doc).toEqual(frozen);
 M.runWorkflow(c,config,workflow,env,'resume');expect(doc.sentAt).toBe(env.now);expect(c.tasks[0].status).toBe('done');
});
it('reconciles current official values before submission and never proposes a stale draft or HR-authored replacement',()=>{
 const {c,env,config,workflow,source}=fixture();M.runWorkflow(c,config,workflow,env,'submitted');const doc=c.documents[0],own={...env,actor:{id:'fictional-employee',name:'Fictional employee'}};
 M.saveDocument(c,doc.id,{F51:'Old employee draft'},'employee',own);source.address='Arrived in official PM';M.submitDocumentPersonnelCompletion(c,doc.id,own);
 expect(doc.values.F51).toBe('Arrived in official PM');expect(doc.personnelCompletion!.fields.F51.conflict?.draft).toBe('Old employee draft');expect(c.pmChanges).toEqual([]);
 source.address='';M.overrideDocumentPersonnelCompletion(c,doc.id,{fieldId:'F51',owner:'hr',reason:'HR verified this answer'},env);M.saveDocument(c,doc.id,{F51:'HR answer'},'hr',env);M.submitDocumentPersonnelCompletion(c,doc.id,own);expect(c.pmChanges).toEqual([]);
 expect(()=>M.saveDocument(c,doc.id,{official:'Forged official name'},'employee',own)).toThrow('cannot be changed');
});
