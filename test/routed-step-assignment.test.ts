// One person for a routed step uses the V9 assignment owner's rule (lane F2): leave today, the open-task limit, the
// lowest open load, then least recent (round robin) or member order (any member). Fictional ids only.
import {describe,expect,it} from 'vitest';
import {routedStepChooser,type RoutedAssignmentFacts} from '../lib/routed-step-assignment';

const facts=(users:RoutedAssignmentFacts['users'],limit=0):RoutedAssignmentFacts=>({today:'2026-11-16',groups:[{id:'ops',name:'Fictional People Ops',limit,members:users.map(u=>u.id)}],users});
const user=(id:string,load=0,lastAssigned:string|null=null,onLeave=false)=>({id,load,lastAssigned,onLeave});

describe('routedStepChooser (V9 assign semantics)',()=>{
 it('skips people on leave today and chooses the lowest open load',()=>{
  const chooser=routedStepChooser(facts([user('a',0,null,true),user('b',3),user('c',1)]));
  expect(chooser.choose(['a','b','c'],'any','ops')).toBe('c');
 });
 it('breaks a load tie by least recent assignment for round robin and by member order for any member',()=>{
  const users=[user('a',1,'2026-11-10T00:00:00Z'),user('b',1,'2026-11-01T00:00:00Z')];
  expect(routedStepChooser(facts(users)).choose(['a','b'],'roundRobin','ops')).toBe('b');
  expect(routedStepChooser(facts(users)).choose(['a','b'],'any','ops')).toBe('a');
 });
 it('respects the open-task limit and says why nobody could take the step',()=>{
  const chooser=routedStepChooser(facts([user('a',2),user('b',2)],2));
  expect(chooser.choose(['a','b'],'any','ops')).toBeNull();
  expect(chooser.problem()).toBe('Everyone available in Fictional People Ops is at their limit of 2 open tasks.');
  const away=routedStepChooser(facts([user('a',0,null,true)]));
  expect(away.choose(['a'],'any','ops')).toBeNull();
  expect(away.problem()).toBe('Everyone in Fictional People Ops is on leave on 2026-11-16.');
 });
 it('counts earlier choices in the same document and treats named people as a small group without a limit',()=>{
  const chooser=routedStepChooser(facts([user('a'),user('b')],1));
  expect(chooser.choose(['a','b'],'any','ops')).toBe('a');
  expect(chooser.choose(['a','b'],'any','ops')).toBe('b');
  expect(chooser.choose(['a','b'],'any','ops')).toBeNull();
  const named=routedStepChooser({today:'2026-11-16',groups:[],users:[user('x',5),user('y',4)]});
  expect(named.choose(['x','y'],'any',null)).toBe('y');
  // Someone no longer active is never chosen.
  expect(named.choose(['gone'],'any',null)).toBeNull();
 });
});
