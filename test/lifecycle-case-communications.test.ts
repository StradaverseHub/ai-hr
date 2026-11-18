import {expect,it} from 'vitest';
import {caseCommunications,communicationCounts,communicationAnchor} from '../lib/lifecycle-case-communications';
import {communicationsFixture} from './helpers/communications-fixture';
it.each(['onb','off'] as const)('partitions exact frozen workflow/run/step rows for %s without counting tests or unscheduled templates',module=>{
 const {c,config}=communicationsFixture(module),before=JSON.stringify({c,config}),view=caseCommunications(c,config,'2026-11-27');
 expect(view.rows.map(row=>row.id)).toEqual(['welcome-flow/held-run/email-step','release-flow/finished-run/receipt','release-flow/finished-run/release']);
 expect(communicationCounts(view.rows)).toEqual({all:3,attention:1,open:0,done:2});expect(view.tests).toHaveLength(1);expect(view.unscheduledEmails.map(email=>email.id)).toEqual(['unused']);
 expect(view.rows.find(row=>row.step?.id==='receipt')?.documents.map(document=>[document.id,document.version])).toEqual([['saved-letter',1]]);
 expect(view.rows.find(row=>row.step?.id==='release')?.documents).toEqual([]);expect(view.rows.find(row=>row.step?.id==='release')?.availableDocument?.id).toBe('saved-letter');
 config.workflows[0].name='Changed current workflow';config.workflows[0].steps=[];
 expect(caseCommunications(c,config,'2026-11-27').rows.find(row=>row.workflow?.id==='welcome-flow')?.workflow?.name).toBe('Fictional welcome workflow');
 expect(JSON.parse(before).c).toEqual(c);
});
it('keeps recurrence bounded and uses the runtime calendar owner rather than manufacturing future runs',()=>{
 const {c,config,workflow}=communicationsFixture();workflow.trigger.repeat=true;workflow.trigger.workdays=true;c.runs=[];config.workflows=[workflow];
 const view=caseCommunications(c,config,'2026-11-27');expect(view.rows).toHaveLength(1);expect(view.rows[0]).toMatchObject({date:'2026-11-25',until:'2026-11-30',status:'open'});expect(c.runs).toEqual([]);
});
it('keeps nonmatching and manually started workflows outside ordinary counts and exact anchors distinct',()=>{
 const {c,config,workflow}=communicationsFixture();c.runs=[];config.workflows=[{...workflow,trigger:{...workflow.trigger,event:'manual'}},{...workflow,id:'outside',conditions:[{field:'company',op:'is',value:'another-company'}]}];
 const view=caseCommunications(c,config,'2026-11-27');expect(view.rows).toEqual([]);expect(view.otherWorkflows.map(workflow=>workflow.id)).toEqual(['welcome-flow']);expect(communicationAnchor('schedule','w/r/s')).not.toEqual(communicationAnchor('document','w/r/s'));
});
