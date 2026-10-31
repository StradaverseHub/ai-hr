import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({scope:vi.fn(),download:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:mocks.scope}));
vi.mock('../core/system-label-import',()=>({downloadSystemLabelTemplate:mocks.download}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=> '2026-10-19'}));
import { GET } from '../app/(app)/admin/settings/system-labels/template/route';
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:{tenantId:'tenant'},scopeIds:['selected-company']});mocks.download.mockResolvedValue(Buffer.from('template bytes'));});
describe('scoped Labels template route',()=>{
  it('passes the global company selection and uses the exact Kuala Lumpur download name',async()=>{
    const response=await GET();
    expect(mocks.download).toHaveBeenCalledWith({tenantId:'tenant'},['selected-company']);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="System_Labels_Upload_Template_20261019.xlsx"');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('preserves an explicitly empty scope and never downloads after an authorization refusal',async()=>{
    mocks.scope.mockResolvedValueOnce({s:{tenantId:'tenant'},scopeIds:[]});await GET();
    expect(mocks.download).toHaveBeenLastCalledWith({tenantId:'tenant'},[]);
    mocks.scope.mockRejectedValueOnce(new Error('Access refused'));mocks.download.mockClear();
    await expect(GET()).rejects.toThrow('Access refused');expect(mocks.download).not.toHaveBeenCalled();
  });
});
