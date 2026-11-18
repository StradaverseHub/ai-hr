import {expect,it,vi} from 'vitest';
import {communicationPreviewSource} from '../lib/lifecycle-case-preview';
import {previewEmail,type Environment,type Step} from '../lib/lifecycle-v9-model';
import {communicationsFixture} from './helpers/communications-fixture';
it('selects the exact second frozen step after the current workflow changed, without allocating a document or changing the case',()=>{
 const {c,config}=communicationsFixture(),run=c.runs[0],definition=run.definition!;
 definition.steps.push({id:'second',type:'email',template:'welcome',to:['group:people'],cc:[]});config.workflows[0].steps=[];config.workflows[0].name='Unrelated current definition';config.emails[0].subject='For {owner.name}';config.emails[0].body='Hello {owner.name}';
 const source=communicationPreviewSource(c,config,{workflowId:definition.id,runId:run.id,stepId:'second'}),step=source.steps.find(step=>step.id==='second') as Extract<Step,{type:'email'}>,nextId=vi.fn();
 const env:Environment={today:'2026-11-27',now:'2026-11-27T00:00:00Z',actor:{id:'hr',name:'Fictional HR'},nextId,onLeave:()=>false,openLoad:()=>0,lastAssigned:()=>0,eligibleUser:()=>true,userName:id=>'Name '+id,mergeValues:{}};
 const before=JSON.stringify({c,config}),preview=previewEmail(c,config,'welcome',env,{workflowId:source.id,step});
 expect(preview.to).toEqual([{id:'hr',name:'Name hr'}]);expect(preview.subject).toBe('For Name hr');expect(source.name).toBe('Fictional welcome workflow');expect(nextId).not.toHaveBeenCalled();expect(JSON.stringify({c,config})).toBe(before);
 expect(previewEmail(c,config,'welcome',env).to[0].id).toBe('employee');
});
it('refuses unknown or cross-module run/step sources instead of falling back to an unrelated current definition',()=>{
 const {c,config}=communicationsFixture();
 expect(()=>communicationPreviewSource(c,config,{workflowId:'welcome-flow',runId:'not-this-case',stepId:'email-step'})).toThrow('unavailable');
 expect(()=>communicationPreviewSource(c,config,{workflowId:'welcome-flow',runId:'held-run',stepId:'missing'})).toThrow('not part');
 c.runs[0].definition=undefined;expect(()=>communicationPreviewSource(c,config,{workflowId:'welcome-flow',runId:'held-run',stepId:'email-step'})).toThrow('not recorded');
});
