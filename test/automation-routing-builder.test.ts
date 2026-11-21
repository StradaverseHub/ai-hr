import {describe,expect,it} from 'vitest';
import {routingDefaultProblems,routingForBuilder} from '../lib/automation/routing-builder';
import {resolveRoutingRow,type Routing} from '../lib/automation/routing';
const group=(id:string)=>({kind:'group' as const,groupId:id});
describe('Shared routing builder default row',()=>{
 it('places the first existing default last without changing the winning row for any existing specificity or tie',()=>{
  const original:Routing={id:'routing',name:'BP routing',rows:[{match:{},assignTo:group('fallback')},{match:{company:['c']},assignTo:group('first')},{match:{company:['c']},assignTo:group('second')},{match:{},assignTo:group('unreachable')}]};
  const edited=routingForBuilder(original,'ignored');expect(edited.rows).toHaveLength(3);expect(edited.rows.at(-1)?.assignTo).toEqual(group('fallback'));
  for(const facts of [{company:'c'},{company:'other'},{}])expect(resolveRoutingRow(edited,facts)?.row.assignTo).toEqual(resolveRoutingRow(original,facts)?.row.assignTo);
  expect(original.rows).toHaveLength(4);expect(routingDefaultProblems(edited)).toEqual([]);
 });
 it('adds an explicit editable target default only to the new builder draft, retaining the original version',()=>{
  const original:Routing={id:'routing',name:'BP routing',rows:[{match:{department:['finance']},assignTo:group('finance')}]};
  const edited=routingForBuilder(original,'ops');expect(original.rows).toHaveLength(1);expect(edited.rows.at(-1)).toEqual({match:{},assignTo:group('ops')});expect(routingDefaultProblems(edited)).toEqual([]);
 });
 it('does not allow an extra unconditional rule or moving the default above a condition',()=>{
  const row={match:{},assignTo:group('ops')},conditional={match:{company:['c']},assignTo:group('bp')};
  expect(routingDefaultProblems({id:'r',name:'R',rows:[row,row]})).not.toEqual([]);expect(routingDefaultProblems({id:'r',name:'R',rows:[row,conditional]})).not.toEqual([]);
 });
});
