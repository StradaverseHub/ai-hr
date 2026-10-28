/** Authored UNRUN: literal no-effect navigation only, never Employee Master Import execution. */
import {describe,it,expect} from 'vitest';
import {EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA,employeeImportHumanHandoff,checkedEmployeeImportHumanHandoff} from '../lib/ai/employee-import-human-handoff';
const literal={module:'employees',action:'employees.import',route:'/admin/personnel/import',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_import_page'} as const;
describe('Employee Master Import human workflow handoff',()=>{
 it('returns only a frozen literal destination, explicit human selection and no effect/authority claim',()=>{
  const value=employeeImportHumanHandoff();expect(value).toEqual(literal);expect(Object.keys(value).sort()).toEqual(Object.keys(literal).sort());expect(Object.isFrozen(value)).toBe(true);expect(Reflect.set(value,'route','https://outside.test')).toBe(false);expect(employeeImportHumanHandoff()).toEqual(literal);
 });
 it('validates the exact closed tuple and discards caller object identity',()=>{const input={...literal},value=checkedEmployeeImportHumanHandoff(input);expect(value).toEqual(literal);expect(value).not.toBe(input);expect(Object.isFrozen(value)).toBe(true);input.route='https://outside.test' as typeof input.route;expect(value.route).toBe('/admin/personnel/import');});
 it.each(['rows','headers','dataset','source','sourceRevision','fileName','sheetName','companyId','mode','model','provider','commit','confirmation','phase','grant','session','url'])('refuses unreviewed model/source field %s instead of silently forwarding it',field=>{
  const packet={...literal,[field]:[{value:'PRIVATE actual employee value'}]};expect(EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA.safeParse(packet).success).toBe(false);expect(()=>checkedEmployeeImportHumanHandoff(packet)).toThrow();
 });
 it.each([
  {module:'payroll'},{action:'employees.import.commit'},{route:'/api/assistant/module-actions'},
  {route:'/admin/personnel/import?companyId=arbitrary'},{route:'https://outside.test/admin/personnel/import'},
  {route:'//outside.test/admin/personnel/import'},{requiresHumanSelection:false},{effect:'write'},
  {authority:'already_authorized'},{phase:'confirm'},
 ])('refuses changed module/action/route/human/effect/authority or executable phase %j',change=>{expect(()=>checkedEmployeeImportHumanHandoff({...literal,...change})).toThrow();});
 it('does not infer any default handoff from missing/malformed data or model execution arguments',()=>{
  for(const value of [undefined,null,[],{},'employees.import',()=>literal])expect(()=>checkedEmployeeImportHumanHandoff(value)).toThrow();
  expect(()=>Reflect.apply(employeeImportHumanHandoff,null,[{rows:[{salary:123}],route:'/admin/personnel/import'}])).toThrow();
  expect(employeeImportHumanHandoff()).toEqual(literal);
 });
});
