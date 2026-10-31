import {beforeEach,expect,it,vi} from 'vitest';
import {parseCsv} from '../lib/csv';
const ports=vi.hoisted(()=>({session:vi.fn(),companies:vi.fn(),scope:vi.fn(),read:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:ports.session}));
vi.mock('../lib/scope',()=>({getScopeIds:ports.scope}));
vi.mock('../core/read',()=>({adminCompanies:ports.companies}));
vi.mock('../packs/rewards/service',()=>({rewardAccessAdministration:ports.read,rewardRoleLabels:{ctro:'CTRO'}}));
import {GET} from '../app/(app)/admin/rewards/access/export/route';
beforeEach(()=>vi.clearAllMocks());
it('exports only the fresh authorized company selection and neutralizes a spreadsheet formula in a person name',async()=>{
 const session={tenantId:'fictional-tenant',userId:'fictional-admin'};
 ports.session.mockResolvedValue(session);ports.companies.mockResolvedValue([{id:'authorized-company'}]);ports.scope.mockResolvedValue(['authorized-company']);
 ports.read.mockResolvedValue({reviews:[{id:'review',company:'Fictional company',unit:'Fictional unit',cycle:'Fictional cycle',year:2026,status:'draft'}],members:[{unitId:'review',name:'=HYPERLINK("https://example.test")',role:'ctro',disabled:false,validFrom:'2026-10-01',validTo:null,suspension:null,coversUserId:null,lastChangedAt:'2026-10-29'}],users:[]});
 const response=await GET(),rows=parseCsv((await response.text()).replace(/^\uFEFF/,''));
 expect(ports.scope).toHaveBeenCalledWith(['authorized-company']);expect(ports.read).toHaveBeenCalledWith(session,['authorized-company']);
 expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(rows).toHaveLength(2);expect(rows[1][0]).toBe('\'=HYPERLINK("https://example.test")');
 expect(rows[0]).not.toContain('Salary');expect(rows[1]).toContain('2026-10-29');
});
