import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({open:vi.fn(),translate:vi.fn()}));
vi.mock('@/packs/lifecycle/service',()=>({openOwnLifecycleDocument:state.open,v9OwnDocument:vi.fn(),v9OwnTask:vi.fn(),v9OwnItem:vi.fn(),v9ReportOwnReturn:vi.fn(),v9OwnEquipmentReceipt:vi.fn()}));
vi.mock('@/lib/authz',()=>({requireModule:vi.fn().mockResolvedValue({tenantId:'fixture-tenant',userId:'fixture-employee'})}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:vi.fn().mockResolvedValue(state.translate)}));
import {openLifecycleDocument} from '../app/me/lifecycle/actions';
it('uses the request-locale generic open error rather than exposing SQL or raw English details',async()=>{
 state.open.mockRejectedValue(new Error('Private database row and internal policy details'));state.translate.mockReturnValue('无法打开文件。请刷新并确认人事部门已发布此文件。');
 const result=await openLifecycleDocument({caseId:'fixture-case',documentId:'fixture-document',revision:1});
 expect(state.translate).toHaveBeenCalledExactlyOnceWith('openError');expect(result).toEqual({ok:false,error:'无法打开文件。请刷新并确认人事部门已发布此文件。'});expect(JSON.stringify(result)).not.toContain('Private database');
});
