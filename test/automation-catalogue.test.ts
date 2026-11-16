import {describe,it,expect} from 'vitest';
import {AUTOMATION_FLOOR} from '../lib/automation/floor';
import {AUTOMATION_CONDITION_OPS} from '../lib/automation/conditions';
import {automationCatalogueProblems,conditionFieldsForTrigger,mergeFieldsForTrigger,type AutomationModuleCatalogue} from '../lib/automation/catalogue';
import {PROBATION_AUTOMATION_CATALOGUE as P,PROBATION_LEGACY_MERGE_FIELDS,PROBATION_LEGACY_RECIPIENTS} from '../lib/automation/catalogues/probation';

describe('Shared automation catalogue checks',()=>{
 it('reports duplicates, unknown triggers and presets a trigger cannot supply',()=>{
  const bad:AutomationModuleCatalogue={module:'probation',label:'x',triggers:[{id:'a',label:'A'},{id:'a',label:'A again'}],skipWhen:[],conditionFields:[{id:'f',label:'F',ops:['is'],triggers:['zzz']},{id:'g',label:'G',ops:[]}],stepTypes:[],recipients:[],mergeFields:[{key:'m',label:'M',group:'X',triggers:['nope']}],legacyEvents:[{event:'old',trigger:'missing',exact:true},{event:'old2',trigger:'a',preset:[{field:'f',op:'is',values:['1']},{field:'h',op:'is',values:['1']}],exact:false}]};
  const problems=automationCatalogueProblems(bad);
  for(const text of['Triggers: a is listed twice.','Add at least one step type.','Condition field f: unknown trigger zzz.','Condition field g: add at least one operator.','Merge field m: unknown trigger nope.','Legacy event old: unknown trigger missing.','Legacy event old2: f is not available for a.','Legacy event old2: unknown condition field h.'])expect(problems).toContain(text);
 });
});

describe('Probation catalogue',()=>{
 it('is internally consistent',()=>expect(automationCatalogueProblems(P)).toEqual([]));
 it('offers the fifteen Probation Confirmation triggers of the handoff (A1)',()=>{
  const prototype=['caseOpened','dueAfterStart','formIssued','dueBeforeReview','lmSubmitted','lowResult','outcomeOverridden','acknowledged','declinedToSign','approvalsComplete','returned','outcomeDecided','letterActionNeeded','letterSentBack','letterReleased'];
  for(const id of prototype)expect(P.triggers.map(t=>t.id)).toContain(id);
  expect(P.triggers.filter(t=>t.dated).map(t=>t.id).sort()).toEqual(['dueAfterStart','dueBeforeReview','kpiOverdue']);
 });
 it('keeps every trigger, recipient and merge field of the notify-only engine (the floor)',()=>{
  const legacy=new Map((P.legacyEvents??[]).map(e=>[e.event,e]));
  for(const event of AUTOMATION_FLOOR.probation.triggerEvents)expect(legacy.has(event)).toBe(true);
  expect(Object.keys(PROBATION_LEGACY_RECIPIENTS).sort()).toEqual([...AUTOMATION_FLOOR.probation.recipientRoles].sort());
  for(const target of Object.values(PROBATION_LEGACY_RECIPIENTS))expect(P.recipients.map(r=>r.id)).toContain(target);
  expect(Object.keys(PROBATION_LEGACY_MERGE_FIELDS).sort()).toEqual([...AUTOMATION_FLOOR.probation.mergeFields].sort());
  for(const target of Object.values(PROBATION_LEGACY_MERGE_FIELDS))expect(P.mergeFields.map(m=>m.key)).toContain(target);
  expect(P.stepTypes.map(s=>s.id)).toContain('notify');
 });
 it('hides Request approval from the Probation step menu (B4) and offers the outcome steps',()=>{
  const steps=P.stepTypes.map(s=>s.id);
  expect(steps).not.toContain('requestApproval');
  for(const id of['generateDocument','sendEmail','notify','createPosting','startOffboarding'])expect(steps).toContain(id);
 });
 it('only offers a condition where its trigger can supply the fact',()=>{
  const fields=(trigger:string)=>conditionFieldsForTrigger(P,trigger).map(f=>f.id);
  expect(fields('outcomeDecided')).toEqual(expect.arrayContaining(['part','outcome','reviewPlan','extensionsUsed']));
  expect(fields('outcomeDecided')).not.toContain('resultBand');
  expect(fields('lowResult')).toEqual(expect.arrayContaining(['resultBand','suggestionOverridden']));
  expect(fields('caseOpened')).not.toContain('part');
  expect(fields('dueBeforeReview')).toContain('pendingStep');
  expect(mergeFieldsForTrigger(P,'caseOpened').map(m=>m.key)).not.toContain('probation.outcome');
  expect(mergeFieldsForTrigger(P,'letterReleased').map(m=>m.key)).toContain('probation.newEndDate');
  for(const field of P.conditionFields)for(const op of field.ops)expect(AUTOMATION_CONDITION_OPS).toContain(op);
 });
});
