import {expect,it} from 'vitest';
import {exactAsciiExtraAssignmentWork} from './performance/employee-choice-exact-ascii-plan-work';
const native=(extra:Record<string,unknown>={})=>({'Node Type':'Result','Actual Rows':0,'Actual Loops':1,...extra});
it('accepts actual pruned or zero-work inactive page hydration while retaining the bulk population separately',()=>{
 expect(exactAsciiExtraAssignmentWork(native({'Actual Rows':30}))).toMatchObject({extraAssignmentProbes:0,pageAssignmentRoots:0});
 expect(exactAsciiExtraAssignmentWork(native({Plans:[native({'Subplan Name':'CTE employee_choice_page_assignments',Plans:[native({Alias:'current_assignment','Actual Loops':0})]})]}))).toMatchObject({extraAssignmentProbes:0,pageAssignmentRoots:1});
});
it('refuses even one extra actual1/25/2000 probe rather than replacing the old bounded hydration claim with a fake pass',()=>{
 for(const probes of [1,25,2000,50000])expect(()=>exactAsciiExtraAssignmentWork(native({Plans:[native({Alias:'current_assignment','Actual Loops':probes})]}))).toThrow('extra Assignment hydration');
 expect(()=>exactAsciiExtraAssignmentWork(native({'Subplan Name':'CTE employee_choice_page_assignments','Actual Rows':1}))).toThrow('Extra native');
});
it('refuses missing malformed duplicate or cyclic actual proof instead of treating it as zero work',()=>{
 for(const value of [null,[],{},native({Alias:'current_assignment','Actual Loops':undefined}),native({Alias:'current_assignment','Actual Loops':-1}),native({Plans:{}}),native({Plans:[native({'Subplan Name':'CTE employee_choice_page_assignments'}),native({'Subplan Name':'CTE employee_choice_page_assignments'})]})])expect(()=>exactAsciiExtraAssignmentWork(value)).toThrow();
 const children:unknown[]=[];const cycle={'Node Type':'Result','Actual Rows':0,'Actual Loops':1,Plans:children};children.push(cycle);expect(()=>exactAsciiExtraAssignmentWork(cycle)).toThrow('Invalid actual');
});
