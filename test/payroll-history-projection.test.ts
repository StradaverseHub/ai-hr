import {describe,expect,it} from 'vitest';
import {QueryBuilder} from 'drizzle-orm/pg-core';
import {and,eq,gt,isNull,or} from 'drizzle-orm';
import {payrollBatch,payrollHistoryEffectiveBatch} from '../db/schema';
describe('canonical imported-history batch projection',()=>{
 it('reads the effective view through a real subquery, never an alias resolving to the physical table',()=>{
  const result=new QueryBuilder().select({id:payrollBatch.id,totals:payrollBatch.totals,employeeCount:payrollBatch.employeeCount}).from(payrollHistoryEffectiveBatch).where(and(eq(payrollBatch.status,'closed'),or(isNull(payrollBatch.historyImportAttemptId),gt(payrollBatch.employeeCount,0)))).toSQL();
  expect(result.sql).toContain('from "payroll_history_effective_batch"');expect(result.sql).toContain(') "payroll_batch"');expect(result.sql).not.toMatch(/from "payroll_batch"(?:\s|$)/);expect(result.params).toEqual(['closed',0]);
 });
});
