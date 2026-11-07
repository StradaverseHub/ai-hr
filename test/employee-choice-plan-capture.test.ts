import {expect,it} from 'vitest';
import {employeeChoicePlanQuery} from './performance/employee-choice-plan-capture';
it('captures actual SELECT/WITH keyword boundaries independently of SQL whitespace',()=>{
 for(const text of ['select 1','SELECT\n1','\tselect\r\n1','with employee_choice_page as (select 1) select * from employee_choice_page',
  'with\nemployee_choice_employments as materialized(select 1) select * from employee_choice_employments','\r\nWiTh\tq as(select 1) select * from q']){
  expect(employeeChoicePlanQuery(text),text).toBe(true);
 }
});
it('does not misclassify a similarly named token, cursor control or ordinary write as a SELECT/WITH body',()=>{
 for(const text of ['selective','withheld','fetch forward 512 from employee_choices','close employee_choices',
  'declare employee_choices no scroll cursor for select 1','update employment set employee_code=employee_code',''])expect(employeeChoicePlanQuery(text),text).toBe(false);
});
