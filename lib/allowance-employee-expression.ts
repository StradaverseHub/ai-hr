/** Client-safe, versioned employee inclusion. Missing facts never pass a negative comparison. */
import { ALLOWANCE_EMPLOYEE_FIELDS, type AllowanceEmployeeField } from './attendance-allowance-vocabulary';
export const ALLOWANCE_EMPLOYEE_FIELDS_V4 = [...ALLOWANCE_EMPLOYEE_FIELDS, 'branch', 'division'] as const;
export type AllowanceEmployeeFieldV4 = typeof ALLOWANCE_EMPLOYEE_FIELDS_V4[number];
export type AllowanceEmployeeComparison = 'is' | 'isNot' | 'in' | 'notIn';
export type AllowanceEmployeeLeaf = {
  id: string; type: 'criterion'; field: AllowanceEmployeeFieldV4;
  operator: AllowanceEmployeeComparison; values: string[];
};
export type AllowanceEmployeeGroup = {
  id: string; type: 'group'; logic: 'and' | 'or'; children: AllowanceEmployeeExpression[];
};
export type AllowanceEmployeeExpression = AllowanceEmployeeLeaf | AllowanceEmployeeGroup;
export type AllowanceEmployeeFactsV4 = Record<AllowanceEmployeeField, string | null> & Partial<Record<'branch' | 'division', string | null>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateAllowanceEmployeeExpression(raw: unknown): AllowanceEmployeeGroup {
  let count = 0;
  const seen = new Set<string>();
  function visit(raw: unknown, depth: number): AllowanceEmployeeExpression {
    if (depth > 6 || ++count > 120 || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Employee groups exceed the supported depth or size.');
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(node.id) || seen.has(node.id)) throw new Error('Employee condition identifiers must be unique.');
    seen.add(node.id);
    const keys = node.type === 'group' ? ['id', 'type', 'logic', 'children'] : ['id', 'type', 'field', 'operator', 'values'];
    if (Object.keys(node).some(key => !keys.includes(key))) throw new Error('Unsupported employee condition property.');
    if (node.type === 'group') {
      if (!['and', 'or'].includes(String(node.logic)) || !Array.isArray(node.children) || !node.children.length || node.children.length > 30) throw new Error('Every employee group needs conditions and an AND or OR choice.');
      return { id: node.id, type: 'group', logic: node.logic as 'and' | 'or', children: node.children.map(child => visit(child, depth + 1)) };
    }
    if (node.type !== 'criterion' || !ALLOWANCE_EMPLOYEE_FIELDS_V4.includes(node.field as AllowanceEmployeeFieldV4) || !['is', 'isNot', 'in', 'notIn'].includes(String(node.operator))) throw new Error('Unsupported employee field or comparison.');
    if (!Array.isArray(node.values) || !node.values.length || node.values.length > 2000 || node.values.some(value => typeof value !== 'string' || !value.trim() || value.length > 150)) throw new Error('Choose complete employee condition values.');
    if (new Set(node.values).size !== node.values.length) throw new Error('Employee condition values must be unique.');
    const values = (node.values as string[]).map(value=>String(node.field).endsWith('Id')?value.toLowerCase():value);
    if(new Set(values).size!==values.length)throw new Error('Employee condition values must be unique.');
    if (['is', 'isNot'].includes(String(node.operator)) && values.length !== 1) throw new Error('Is and Is Not require exactly one value.');
    if (String(node.field).endsWith('Id') && values.some(value => !UUID.test(value))) throw new Error('Invalid employee condition reference.');
    if (node.field === 'status' && values.some(value => !['active', 'terminated'].includes(value))) throw new Error('Unknown employee status.');
    if (node.field === 'employmentType' && values.some(value => !['full_time', 'part_time', 'contract', 'intern'].includes(value))) throw new Error('Unknown employment type.');
    return { id: node.id, type: 'criterion', field: node.field as AllowanceEmployeeFieldV4, operator: node.operator as AllowanceEmployeeComparison, values };
  }
  const result = visit(raw, 0);
  if (result.type !== 'group') throw new Error('Employee conditions need a root group.');
  return result;
}
export function allowanceEmployeeExpressionMatches(node: AllowanceEmployeeExpression, facts: AllowanceEmployeeFactsV4): boolean {
  if (node.type === 'group') return node.children.length > 0 && (node.logic === 'and' ? node.children.every(child => allowanceEmployeeExpressionMatches(child, facts)) : node.children.some(child => allowanceEmployeeExpressionMatches(child, facts)));
  const actual = facts[node.field];
  if (actual == null || actual === '') return false;
  return node.operator === 'is' || node.operator === 'in' ? node.values.includes(actual) : !node.values.includes(actual);
}
export function allowanceEmployeeLeaves(node: AllowanceEmployeeExpression): AllowanceEmployeeLeaf[] {
  return node.type === 'criterion' ? [node] : node.children.flatMap(allowanceEmployeeLeaves);
}
