/** Browser-command adapter contract only; authored UNRUN. Framework POST/origin journey remains required. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:vi.fn(),run:vi.fn(),redirect:vi.fn((url:string)=>{throw Error('NAVIGATE '+url);})}));
vi.mock('@/lib/session',()=>({getBrowserCommandSession:state.session}));
vi.mock('@/core/module-agent-releases',()=>({runGovernedModuleReadPlan:state.run}));
vi.mock('next/navigation',()=>({redirect:state.redirect}));
import {runGovernedPlanAction} from '../app/(app)/assistant/governed-job-actions';
beforeEach(()=>{vi.clearAllMocks();state.session.mockResolvedValue({tenantId:'fictional-tenant',userId:'fictional-user'});state.run.mockResolvedValue({jobId:'11111111-1111-1111-1111-111111111111',results:[{private:'NEVER_IN_URL'}]});});
afterEach(()=>vi.restoreAllMocks());
const form=()=>{const value=new FormData();value.set('commandNonce','22222222-2222-2222-2222-222222222222');value.append('module','employees');value.append('module','leave');value.append('module','');return value;};
describe('explicit human governed-plan POST adapter',()=>{
 it('uses strict command authentication, passes only the closed human choices/nonce, and redirects to an opaque job ID',async()=>{
  const value=form();value.set('facts','MODEL_POSTED_PAY_99999');await expect(runGovernedPlanAction(value)).rejects.toThrow('NAVIGATE /assistant?governed=11111111-1111-1111-1111-111111111111');
  expect(state.session).toHaveBeenCalledTimes(1);expect(state.run).toHaveBeenCalledWith({tenantId:'fictional-tenant',userId:'fictional-user'},{version:1,modules:['employees','leave']},{nonce:'22222222-2222-2222-2222-222222222222'});
  expect(JSON.stringify(state.redirect.mock.calls)).not.toContain('NEVER_IN_URL');expect(JSON.stringify(state.redirect.mock.calls)).not.toContain('99999');
 });
 it('captures mutable FormData before awaiting the authenticated session',async()=>{
  let release!:(value:unknown)=>void;state.session.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const value=form(),pending=runGovernedPlanAction(value);
  value.set('module','payroll');value.set('commandNonce','33333333-3333-3333-3333-333333333333');release({tenantId:'fictional-tenant',userId:'fictional-user'});
  await expect(pending).rejects.toThrow('NAVIGATE');expect(state.run.mock.calls[0].slice(1)).toEqual([{version:1,modules:['employees','leave']},{nonce:'22222222-2222-2222-2222-222222222222'}]);
 });
 it('returns bounded public copy routing on command errors and never dumps the caught internal message',async()=>{
  state.run.mockRejectedValueOnce(Error('PRIVATE_DATABASE_OR_PERMISSION_DETAIL'));await expect(runGovernedPlanAction(form())).rejects.toThrow('NAVIGATE /assistant?error=governed_job');
  expect(JSON.stringify(state.redirect.mock.calls)).not.toContain('PRIVATE_DATABASE_OR_PERMISSION_DETAIL');
 });
 it('fails closed with the same bounded route when strict command authentication refuses a stale browser',async()=>{
  state.session.mockRejectedValueOnce(Error('PRIVATE_AUTH_MODE_OR_USER_DETAIL'));await expect(runGovernedPlanAction(form())).rejects.toThrow('NAVIGATE /assistant?error=governed_job');
  expect(state.run).not.toHaveBeenCalled();expect(JSON.stringify(state.redirect.mock.calls)).not.toContain('PRIVATE_AUTH_MODE_OR_USER_DETAIL');
 });

});
