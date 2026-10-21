import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({subjects:vi.fn(),lines:vi.fn(),photo:vi.fn(),tenant:vi.fn()}));
vi.mock('../db/client',()=>({withTenant:state.tenant}));
vi.mock('../core/read',()=>({myOwnEmploymentSubjects:state.subjects,reportingLinesFor:state.lines}));
vi.mock('../core/person-photo',()=>({hasPersonPhoto:state.photo}));
import {readEmployeeHomeIdentity,readEmployeeHomeGreetingIdentity} from '../core/employee-home';

const ctx={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee']};
beforeEach(()=>{
  vi.resetAllMocks();state.subjects.mockResolvedValue([{employmentId:'own',employeeCode:'0007',company:'Fictional company',companyProof:{companyId:'company'}}]);
  state.lines.mockResolvedValue({reports:[]});state.tenant.mockResolvedValue('Fictional recorded name');state.photo.mockResolvedValue(false);
});
describe('Home identity versus greeting presentation failure',()=>{
  it('resolves employment/role while a photo read fails, without pretending the greeting is empty',async()=>{
    state.photo.mockRejectedValueOnce(new Error('Fictional private photo failure'));
    const identity=await readEmployeeHomeIdentity(ctx);
    expect(identity).toMatchObject({role:'employee',employmentState:'selected',selectedEmploymentId:'own'});
    expect(state.photo).not.toHaveBeenCalled();expect(state.tenant).not.toHaveBeenCalled();
    expect(identity).not.toHaveProperty('name');expect(identity).not.toHaveProperty('photoHref');
    await expect(readEmployeeHomeGreetingIdentity(ctx)).rejects.toThrow('Fictional private photo failure');
    expect(state.photo).toHaveBeenCalledWith(ctx,'fictional-person');
  });
  it('refuses a non-own selector before reading any greeting facts',async()=>{
    await expect(readEmployeeHomeGreetingIdentity(ctx,'not-own')).rejects.toMatchObject({code:'employmentUnavailable'});
    expect(state.photo).not.toHaveBeenCalled();expect(state.tenant).not.toHaveBeenCalled();
  });
});
