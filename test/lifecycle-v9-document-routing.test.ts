import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import * as M from '../lib/lifecycle-v9-model';
import {resolveDocumentRouting,type DocumentRouting} from '../lib/document-signing-routing';
import {recordV9DocumentRouteAction,reviseV9DocumentRouting,v9SigningCanonicalText,v9DocumentSigningContent,v9RouteReadyForEmployee,v9RoutedHrComplete} from '../lib/lifecycle-v9-document-routing';
import {canEditSigningContent,pendingSigningSteps,signingSendBack,currentRoundActions} from '../lib/document-signing-model';
function fixture(module: M.Module = 'off') {
  let sequence = 0;
  const environment: M.Environment = { today: '2026-10-30', now: '2026-10-30T00:00:00Z', actor: { id: 'hr', name: 'People Ops' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: () => 0, lastAssigned: () => 0, eligibleUser: () => true, userName: id => id, mergeValues: { 'employee.name': 'Person', 'company.name': 'Company' } };
  const c: M.Case = { version: 9, id: 'case', number: 'OFB-1', module, revision: 1, state: 'submitted', facts: { name: 'Person', employeeNo: 'EMP-1', employmentId: 'employment', personId: 'person', joinDate: '2026-10-01', lastDay: '2026-10-30', noticeDate: '2026-09-30', employeeUserId: 'employee', supervisorUserId: 'manager', taUserId: 'ta', businessGroup: 'group', company: 'company', department: 'dept', grade: 'grade', employmentType: 'contract', title: 'title', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'personnel-1', submittedAt: environment.now, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '2026-10-30', finalFigures: null, review: null };
  const config: M.Config = { version: 9, revision: 1, checklists: [], templates: [], emails: [], workflows: [], groups: [{ id: 'ops', name: 'HR Ops', members: ['hr', 'hr2'], limit: 4 }], peopleOpsGroup: 'ops', };
  const figures: M.FinalFigures = { sourceRevision: 'payroll-1', lastDay: '2026-10-30', leaveDays: '2.5', amount: '500.00', currency: 'MYR', payDate: '2026-11-25', lockedAt: '', payrollReference: 'payroll-input-1' };
  return { c, config, environment, figures };
}
function task(id: string, dueOn = '2026-10-30', owner = 'hr'): M.Task { return { id, name: id, by: 'group', group: 'ops', mode: 'rr', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'signed', opensOn: null, dueOn, assignee: owner, status: 'todo', reason: '', assignmentFailure: null }; }
function workflow(overrides: Partial<M.Workflow> = {}): M.Workflow { return { id: 'workflow', name: 'Reminder', module: 'off', status: 'published', trigger: { event: 'beforeLWD', days: 5, workdays: false, repeat: true, skipIf: 'noPre' }, conditions: [], steps: [{ id: 'notify', type: 'notify', subject: 'Work for {employee.name}', body: 'Hi {owner.name}\n{pending.tasks}', to: 'taskOwners', cc: [] }], description: '', ...overrides }; }
function template(): M.Template { return { id: 'exit', name: 'Exit form', module: 'off', type: 'Form', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [], fields: [{ id: 'answer', label: 'Your answer', type: 'text', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }] }] }; }


function routed(){
 const f=fixture();const definition=template();definition.versions[0].fields=[];
 const routing:DocumentRouting=[{id:'review',order:1,action:'review',who:{kind:'people',userIds:['hr']},owner:true},{id:'hr-sign',order:2,action:'sign',who:{kind:'people',userIds:['hr2']},owner:false},{id:'employee-sign',order:2,action:'sign',who:{kind:'employee'},owner:false},{id:'optional',order:2,action:'approve',who:{kind:'people',userIds:['observer']},owner:false,required:false}];
 definition.versions[0].routing=routing;definition.versions[0].blocks=[{id:'text',type:'text',text:'Original wording',section:''},{id:'hr-block',type:'signature',text:'',section:'',role:'step:hr-sign'},{id:'employee-block',type:'signature',text:'',section:'',role:'step:employee-sign'}];f.config.templates=[definition];
 f.environment.mergeValues['bankAcc']='Private unrelated account';f.environment.documentRouting={tenantId:'tenant',hash:text=>createHash('sha256').update(text).digest('hex'),resolve:routing=>resolveDocumentRouting(routing,{employeeUserId:'employee',directSuperiorUserId:'manager',facts:{},routing:()=>null,groupMembers:()=>null,choose:ids=>ids[0]??null,fallback:null,describe:()=>''})};
 const document=M.generate(f.c,f.config,definition.id,f.environment);return {...f,document,definition};
}
function action(f:ReturnType<typeof routed>,user:string,stepId:string,kind:'signed'|'reviewed'|'returned'|'resent',id=kind+stepId){return recordV9DocumentRouteAction(f.document,{id,stepId,revision:f.document.signing!.contentRevision,hash:f.document.signing!.contentHash,action:kind,comment:kind==='returned'?'Please correct the wording.':'',...(kind==='signed'?{signature:{method:'typed' as const,value:user,consent:true as const}}:{})},{id:user,personId:'person-'+user,name:user},f.environment.now);}
it('freezes the saved version and resolved recipients; legacy HR-first documents retain their existing path',()=>{
 const f=routed();expect(f.document.mergeValues).not.toHaveProperty('bankAcc');expect(f.document.signing?.route.steps.map(s=>s.holderId)).toEqual(['hr','hr2','employee','observer']);
 f.definition.versions[0].routing![0].who={kind:'people',userIds:['replacement']};expect(f.document.routing?.[0].who).toEqual({kind:'people',userIds:['hr']});
 const legacy=fixture();const t=template();t.hrStep='before';legacy.config.templates=[t];const d=M.generate(legacy.c,legacy.config,t.id,legacy.environment);expect(d.signing).toBeUndefined();expect(d.hrStep).toBe('before');
 expect(()=>M.signDocument(f.c,f.config,f.document.id,'hr',{by:f.environment.actor,at:f.environment.now,method:'typed',value:'hr',consent:true},f.environment)).toThrow();
});
it('allows Review edits until the first signature, completes parallel required stages, and ignores optional approval for completion',()=>{
 const f=routed();expect(canEditSigningContent(f.document.signing!,'hr')).toBe(true);f.document.edits.text='Reviewed wording';reviseV9DocumentRouting(f.document,f.environment);expect(f.document.signing?.contentRevision).toBe(2);
 action(f,'hr','review','reviewed');expect(pendingSigningSteps(f.document.signing!).map(s=>s.id)).toEqual(['hr-sign','employee-sign','optional']);
 action(f,'hr2','hr-sign','signed');expect(canEditSigningContent(f.document.signing!,'hr')).toBe(false);f.document.edits.text='Forbidden';expect(()=>reviseV9DocumentRouting(f.document,f.environment)).toThrow();f.document.edits.text='Reviewed wording';
 action(f,'employee','employee-sign','signed');expect(f.document.status).toBe('signed');expect(Object.keys(f.document.stepSignatures!)).toEqual(['hr-sign','employee-sign']);
});
it('a completed frozen holder may send back with comment, clearing current signatures while retaining audit; only owner can resend',()=>{
 const f=routed();action(f,'hr','review','reviewed');action(f,'hr2','hr-sign','signed');action(f,'hr2','hr-sign','returned');
 expect(f.document.stepSignatures).toEqual({});expect(currentRoundActions(f.document.signing!).map(a=>a.action)).toEqual(['returned']);expect(f.document.signing?.actions).toHaveLength(3);expect(signingSendBack(f.document.signing!)).not.toBeNull();
 expect(()=>action(f,'employee','employee-sign','resent')).toThrow();action(f,'hr','review','resent');expect(pendingSigningSteps(f.document.signing!).map(s=>s.id)).toEqual(['review']);expect(f.document.signing?.actions).toHaveLength(4);
});
it('binds workflow runs to one exact completed saved document revision, keeping outbox keys stable on retry',()=>{
 const f=routed();action(f,'hr','review','reviewed');action(f,'hr2','hr-sign','signed');action(f,'employee','employee-sign','signed');
 const w=workflow({trigger:{event:'docSigned',days:0,workdays:false,repeat:false,skipIf:''},steps:[{id:'wait',type:'waitSign',template:f.document.templateId,by:'employee'},{id:'notify',type:'notify',subject:'Signed',body:'Signed document',to:['employee'],cc:[]}]});
 const sourceEvent={kind:'docSigned' as const,sourceId:f.document.id,revision:f.document.signing!.contentRevision,at:f.environment.now};
 M.runWorkflow(f.c,f.config,w,f.environment,'docSigned',{sourceEvent});M.runWorkflow(f.c,f.config,w,f.environment,'docSigned',{sourceEvent});expect(f.c.runs).toHaveLength(1);expect(f.c.mails).toHaveLength(1);expect(f.c.runs[0].sourceEvent).toEqual(sourceEvent);expect(f.c.runs[0].status).toBe('done');
});
it('canonicalizes the precise JSONB signature envelope with byte-length key order',()=>{expect(v9SigningCanonicalText({zz:'a',a:'b',é:'c',nil:null,empty:[],bool:true})).toBe('{"a": "b", "zz": "a", "é": "c", "nil": null, "bool": true, "empty": []}');const f=routed();expect(f.document.signing?.contentHash).toBe(createHash('sha256').update(v9SigningCanonicalText(v9DocumentSigningContent(f.document))).digest('hex'));expect(v9RouteReadyForEmployee(f.document)).toBe(false);});

it('admits a second exact document completion even while another notification from the same workflow is held',()=>{
 const f=routed();const w=workflow({trigger:{event:'docSigned',days:0,workdays:false,repeat:false,skipIf:''},steps:[{id:'notify',type:'notify',subject:'Signed',body:'Saved document signed',to:['supervisor'],cc:[]}]});f.c.facts.supervisorUserId=null;
 const first={kind:'docSigned' as const,sourceId:'document-one',revision:1,at:f.environment.now},second={...first,sourceId:'document-two'};
 M.runWorkflow(f.c,f.config,w,f.environment,'docSigned',{sourceEvent:first});expect(f.c.runs[0].hold).toBeDefined();M.runWorkflow(f.c,f.config,w,f.environment,'docSigned',{sourceEvent:second});
 expect(f.c.runs).toHaveLength(2);expect(f.c.runs.map(r=>r.sourceEvent?.sourceId)).toEqual(['document-one','document-two']);expect(f.c.runs.every(r=>r.status==='waiting'&&!!r.hold)).toBe(true);expect(f.c.mails).toEqual([]);
});

it('never invents HR signing from review or approval decisions, or from employee-only signatures',()=>{
 const f=routed();f.document.signing!.route.steps=f.document.signing!.route.steps.filter(step=>step.id!=='hr-sign');expect(v9RoutedHrComplete(f.document)).toBe(false);action(f,'hr','review','reviewed');expect(v9RoutedHrComplete(f.document)).toBe(false);action(f,'employee','employee-sign','signed');expect(f.document.status).toBe('signed');expect(v9RoutedHrComplete(f.document)).toBe(false);
 const actual=routed();action(actual,'hr','review','reviewed');action(actual,'hr2','hr-sign','signed');expect(v9RoutedHrComplete(actual.document)).toBe(true);
});
