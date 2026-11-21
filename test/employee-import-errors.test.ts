import {beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({admin:vi.fn(),validate:vi.fn(),commit:vi.fn(),syncCommit:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/authz',()=>({requireAdmin:h.admin}));
vi.mock('next/cache',()=>({revalidatePath:h.revalidate}));
vi.mock('../core/import',()=>({validateEmployeeImport:h.validate,commitEmployeeImport:h.syncCommit}));
// f34d15dc0 moved the commit owner to the background job's admission (the worker writes); the synchronous writer is gone
// from this action, and the same refusals must still come back before that owner runs.
vi.mock('../core/employee-import-job',()=>({createEmployeeImportJob:h.commit,EmployeeImportJobError:class EmployeeImportJobError extends Error{}}));
vi.mock('../lib/personnel-import-labels.server',()=>({personnelImportLabelResolvers:[]}));
import {validateImportAction,commitImportAction} from '../app/admin/personnel/import/actions';
import {parseEmployeeImportText} from '../lib/employee-import-error.server';
import {WorkforceAccessError} from '../core/workforce-access';
const csv='full_name,email\nFictional Person,fictional@example.test';
beforeEach(()=>{vi.resetAllMocks();h.admin.mockResolvedValue({tenantId:'fixture',userId:'fixture'});});
describe('employee import production error boundary',()=>{
  it.each([validateImportAction,commitImportAction])('returns blank-header guidance as serializable data before any owner runs',async action=>{
    const result=await action('full_name,,email\nFictional,,fictional@example.test','company');
    expect(JSON.parse(JSON.stringify(result))).toEqual({error:expect.stringMatching(/employee worksheet.*blank column heading at column 2/)});
    expect(h.validate).not.toHaveBeenCalled();expect(h.commit).not.toHaveBeenCalled();expect(h.syncCommit).not.toHaveBeenCalled();expect(h.revalidate).not.toHaveBeenCalled();
  });
  it('names the Family worksheet when its heading is blank',async()=>{
    expect(await validateImportAction(csv,'company','employee_code,,full_name\nA001,,Fictional Child')).toEqual({error:expect.stringMatching(/family worksheet.*column 2/)});
    expect(h.validate).not.toHaveBeenCalled();
  });
  it('returns file size guidance without parsing or writing',async()=>{
    expect(await validateImportAction('x'.repeat(900001),'company')).toEqual({error:'The import is too large. Split the workbook and check each part.'});
    expect(h.validate).not.toHaveBeenCalled();expect(h.commit).not.toHaveBeenCalled();
  });
  it('preserves authorization redirects',async()=>{
    const redirect=new Error('NEXT_REDIRECT');h.admin.mockRejectedValue(redirect);
    await expect(validateImportAction(csv,'company')).rejects.toBe(redirect);
    expect(h.validate).not.toHaveBeenCalled();
  });
  it('returns the safe Workforce refusal',async()=>{
    h.validate.mockRejectedValue(new WorkforceAccessError());
    expect(await validateImportAction(csv,'company')).toEqual({error:'Employee record or permission is unavailable.'});
  });
  it('does not expose private driver messages or parameters',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      h.validate.mockRejectedValue(Object.assign(new Error('Failed query: PRIVATE person and SQL'),{cause:{code:'42501'}}));
      const result=await validateImportAction(csv,'company');
      expect(result).toEqual({error:expect.stringMatching(/permission.*Reference/)});
      expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(log).toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
  it.each(['validate','commit'] as const)('logs an unexpected %s failure under a reference without exposing it',async operation=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      h[operation].mockRejectedValue(new Error('PRIVATE internals'));
      const result=await (operation==='validate'?validateImportAction:commitImportAction)(csv,'company');
      expect(result).toEqual({error:expect.stringMatching(/reference [A-F0-9]{12}/)});
      expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(log).toHaveBeenCalled();
      expect(h.revalidate).not.toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
  it('leaves a successful preview intact',async()=>{
    const preview={rows:[],validCount:0};h.validate.mockResolvedValue(preview);
    expect(await validateImportAction(csv,'company')).toBe(preview);expect(h.commit).not.toHaveBeenCalled();
  });
});

it.each(['full_name,,email\nFictional,,fixture@example.test','full_name, ,email\nFictional,has data,fixture@example.test','full_name,email,\nFictional,fixture@example.test,'])('identifies a blank heading without silently discarding its cells: %s',csv=>{
  expect(()=>parseEmployeeImportText(csv,{columns:['full_name','email']})).toThrow(/blank column heading at column [23].*remove the column if it is unused/);
});
