import { expect, it } from 'vitest';
import * as M from '../lib/onboarding-model';
function fixture(adopted = true) {
  let sequence = 0;
  const config = M.defaultConfig('a'); if (adopted) config.v9ChecklistRevision = 9;
  config.groups = [{ id: 'team', name: 'Fulfilling team', members: ['a','b'], limit: 1 }, { id: 'facility', name: 'Facility', members: ['a'], limit: 0 }]; config.techGroup = 'team'; config.exceptions.confirmingGroup = 'team'; config.exceptions.groups = ['team'];
  config.catalogue = ['one','two','three'].map(id => ({ id, name: id, type: 'system' as const, active: true, rules: {}, workflow: null, team: 'team', card: false }));
  const env: M.Environment = { today: '2026-10-30', now: '2026-10-30T00:00:00Z', id: () => 'id-' + ++sequence, nextNumber: () => 'IT-REQ-1', users: ['a','b'], leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, userNames: { a: 'First member', b: 'Second member' } };
  const actor: M.Actor = { id: 'a', name: 'First member', module: true, hr: true, master: true };
  const c = M.blankCase('case','OB-1','draft',{ fullName: 'Fictional equipment joiner', joinDate: '2026-11-02', company: 'company', department: 'department', title: 'title', supervisor: 'b' }, env); c.hiring = 'new_hire';
  return { config, c, actor, env };
}
it('uses V9 due Day -1, caps and member-order balancing, while legacy requisitions keep their claim flow', () => {
  const { config, c, actor, env } = fixture(); c.selected = ['one','two','three']; M.submitCase(config,c,actor,env);
  expect(M.currentReq(c)!.items.map(item => [item.claim, M.equipmentDate(c,item)])).toEqual([['a','2026-11-01'],['b','2026-11-01'],[null,'2026-11-01']]);
  expect(M.currentReq(c)!.items[2].assignmentFailure).toContain('open-task limit');
  const legacy = fixture(false); legacy.c.selected = ['one']; M.submitCase(legacy.config,legacy.c,legacy.actor,legacy.env);
  expect(M.currentReq(legacy.c)!.items[0].claim).toBeNull(); expect(M.equipmentDate(legacy.c,M.currentReq(legacy.c)!.items[0])).toBe('2026-11-02');
});
it('keeps draft preferences case-local and skips completed work during bulk changes', () => {
  const { config,c,actor,env } = fixture(); c.selected = ['one','two'];
  M.bulkEquipment(config,c,{ids:['one','two'],method:'manual',due:0},actor,env); M.submitCase(config,c,actor,env);
  const [one,two] = M.currentReq(c)!.items;
  expect([one.claim,two.claim]).toEqual([null,null]); expect(M.equipmentDate(c,one)).toBe('2026-11-02');
  M.fulfil(config,c,one.id,'done',actor,env); const completed = structuredClone(one);
  M.bulkEquipment(config,c,{ids:[one.id,two.id],group:'facility',method:'rr',due:-3},actor,env);
  expect(one).toEqual(completed); expect(c.history.at(-1)?.detail).toContain('1 items'); expect(two).toMatchObject({team:'facility',claim:'a',dueDay:-3,fulfilmentMethod:'rr'}); expect(M.equipmentDate(c,two)).toBe('2026-10-30');
  expect(() => M.dayDate('2026-11-02',0)).toThrow('Day 0');
});
it('checks leave on the selected due date and never partially applies a foreign-item bulk request', () => {
  const {config,c,actor,env} = fixture(); c.selected = ['one']; env.leave.a = ['2026-11-01']; M.submitCase(config,c,actor,env);
  const item = M.currentReq(c)!.items[0]; expect(item.claim).toBe('b');
  const before = JSON.stringify(c); expect(() => M.bulkEquipment(config,c,{ids:[item.id,'foreign'],group:'facility'},actor,env)).toThrow('no longer available'); expect(JSON.stringify(c)).toBe(before);
  expect(() => M.manualEquipment(config,c,item.id,'a',{...actor,id:'outsider',module:false},env)).toThrow('fulfilling team');
});
it('waits for approval before assigning equipment and retains the fulfilling owner after completion', () => {
  const {config,c,actor,env} = fixture(); config.workflows = [{id:'approval',name:'Approval',mode:'seq',steps:[{id:'person',label:'Review',type:'person',target:'b',method:'manual'}]}]; config.catalogue[0].workflow = 'approval'; c.selected = ['one'];
  M.submitCase(config,c,actor,env); const item = M.currentReq(c)!.items[0]; expect(item.approval).toBe('pending'); expect(item.claim).toBeNull();
  M.decide(config,c,[item.id],'approve',{...actor,id:'b',name:'Second member'},env); expect(item.claim).toBe('a');
  M.fulfil(config,c,item.id,'done',actor,env); expect(item.state).toBe('ready'); expect(item.claim).toBe('a'); expect(env.taskLoads.a).toBe(0);
  expect(() => M.fulfil(config,c,item.id,'todo',actor,env)).toThrow('Completed equipment');
});
it('assigns the second access-card stage to its canonical tech team after printing', () => {
  const {config,c,actor,env} = fixture(); config.groups[0].members = ['b']; config.catalogue[0] = {...config.catalogue[0],type:'device',card:true,team:'facility'}; c.selected = ['one'];
  M.submitCase(config,c,actor,env); const item = M.currentReq(c)!.items[0]; expect(item.claim).toBe('a');
  M.fulfil(config,c,item.id,'done',actor,env); expect(item).toMatchObject({state:'printed',stage:'tech',team:'team',claim:'b'});
  M.fulfil(config,c,item.id,'done',{...actor,id:'b'},env); expect(item).toMatchObject({state:'ready',claim:'b'});
});
