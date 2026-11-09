import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactNode} from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({companies:vi.fn(),departments:vi.fn(),units:vi.fn(),heads:vi.fn(),grid:vi.fn()}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'tenant',userId:'admin',roles:['hr_admin']}),isGroupAdmin:()=>true}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('../core/read',()=>({listJobGrades:async()=>[]}));
vi.mock('../core/admin',()=>({listDepartmentsForLabels:mocks.departments,listBusinessUnitsForLabels:mocks.units,listPositionsForLabels:async()=>[],listCostCentersForLabels:async()=>[]}));
vi.mock('../core/system-labels',()=>({labelMaintenanceCompanies:mocks.companies,labelMaintenanceHeadSelections:mocks.heads,
 labelMaintenanceHeadOptions:()=>{throw Error('Initial page must not enumerate the workforce');}}));
vi.mock('../core/profile-options',()=>({EMPLOYMENT_PROFILE_CATEGORIES:[],listAllProfileOptions:async()=>[]}));
vi.mock('../packs/leave/service',()=>({listGradeGroups:async()=>[]}));
vi.mock('../components/system-label-import-tools',()=>({SystemLabelImportTools:()=>null}));
vi.mock('../components/grade-labels-grid',()=>({GradeLabelsGrid:()=>null}));
vi.mock('../components/leave/grade-group-config',()=>({GradeGroupConfig:()=>null}));
vi.mock('../components/profile-options-grid',()=>({ProfileOptionsGrid:()=>null}));
vi.mock('../components/system-labels-tabs',()=>({SystemLabelsTabs:()=>null}));
vi.mock('../components/ui',()=>({Card:({children}:{children:ReactNode})=><section>{children}</section>,ErrorBanner:()=>null,PageHeader:({title}:{title:string})=><h1>{title}</h1>}));
vi.mock('../components/system-labels-grid',()=>({SystemLabelsGrid:(props:{headByCompany:Record<string,{id:string;label:string}[]>})=>{mocks.grid(props);return <section>{Object.values(props.headByCompany).flat().map(row=><p key={row.id}>{row.label}</p>)}</section>;}}));
vi.mock('../app/admin/settings/system-labels/profile-options/actions',()=>({removeProfileOptionAction:vi.fn(),saveProfileOptionsAction:vi.fn()}));
vi.mock('../app/admin/settings/actions',()=>({assignLabelCompaniesAction:vi.fn(),copyLabelsToCompaniesAction:vi.fn(),removeJobGradeGridAction:vi.fn(),restoreJobGradeGridAction:vi.fn(),saveJobGradesGridAction:vi.fn(),saveLabelsGridAction:vi.fn(),setLabelCriteriaAction:vi.fn(),unassignLabelCompaniesAction:vi.fn()}));
vi.mock('../app/admin/actions',()=>({createGradeGroupAction:vi.fn(),deleteGradeGroupAction:vi.fn(),updateGradeGroupAction:vi.fn()}));
import Page from '../app/admin/settings/system-labels/page';
const companyId='00000000-0000-0000-0000-000000000001',headId='00000001-0000-0000-0000-000000000001';
const label=(id:string,headEmploymentId:string|null)=>({id,companyId,code:id,name:id,assignedCompanyIds:[companyId],isGlobal:false,archivedAt:null,inUse:false,createdAt:new Date('2020-01-01T00:00:00Z'),headEmploymentId});
beforeEach(()=>{vi.clearAllMocks();mocks.companies.mockResolvedValue([{id:companyId,name:'Fictional company',archivedAt:null}]);mocks.departments.mockResolvedValue([]);mocks.units.mockResolvedValue([]);mocks.heads.mockResolvedValue([]);});
it('renders an empty-label workspace independently of the workforce population',async()=>{
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(html).toContain('pageTitle');expect(mocks.heads).toHaveBeenCalledWith(expect.objectContaining({userId:'admin'}),[]);
 expect(mocks.grid).toHaveBeenCalledOnce();expect(mocks.grid.mock.calls[0][0].headByCompany).toEqual({});
});
it('requests only distinct configured heads and renders their exact retained labels',async()=>{
 mocks.departments.mockResolvedValue([label('Department',headId)]);mocks.units.mockResolvedValue([label('Business unit',headId)]);
 mocks.heads.mockResolvedValue([{employmentId:headId,companyId,name:'Retained ended head',employeeCode:'END001'}]);
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(mocks.heads).toHaveBeenCalledWith(expect.objectContaining({userId:'admin'}),[headId]);
 expect(html).toContain('Retained ended head (END001)');expect(mocks.grid.mock.calls[0][0].headByCompany).toEqual({[companyId]:[{id:headId,label:'Retained ended head (END001)'}]});
});
