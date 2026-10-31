/** Mocked server-action boundaries only; actual session/role/RLS proof belongs to DB suites. */
import {beforeEach,expect,it,vi} from 'vitest';
const owner=vi.hoisted(()=>({session:vi.fn(),record:vi.fn(),erase:vi.fn()}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:owner.session}));
vi.mock('../core/module-agent-feedback',()=>({recordOwnAgentFeedback:owner.record,eraseOwnAgentFeedback:owner.erase,AGENT_FEEDBACK_OUTCOMES:['helpful','needs_correction','incorrect']}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(location:string)=>{throw Object.assign(Error('fixture navigation'),{location});}}));
import {saveAgentFeedbackAction,eraseAgentFeedbackAction} from '../app/(app)/assistant/feedback-actions';
const ctx={tenantId:'fixture-tenant',userId:'fixture-user'};
beforeEach(()=>{for(const mock of Object.values(owner))mock.mockReset();owner.session.mockResolvedValue(ctx);});
function packet(){const form=new FormData();form.set('exchangeId','original-exchange');form.set('outcome','helpful');form.set('consented','yes');return form;}
async function location(call:()=>Promise<unknown>){try{await call();throw Error('Expected navigation');}catch(error){const value=(error as {location?:unknown}).location;if(typeof value!=='string')throw error;return value;}}
it('bounds session and owner failures for record and erasure without echoing private diagnostics',async()=>{
 owner.session.mockRejectedValueOnce(Error('PRIVATE_SESSION_OR_DATABASE'));expect(await location(()=>saveAgentFeedbackAction(packet()))).toBe('/assistant?error=feedback');
 owner.session.mockRejectedValueOnce(Error('PRIVATE_SESSION_OR_DATABASE'));expect(await location(eraseAgentFeedbackAction)).toBe('/assistant?ownClear=unavailable');
 expect(owner.record).not.toHaveBeenCalled();expect(owner.erase).not.toHaveBeenCalled();
 owner.record.mockRejectedValueOnce(Error('PRIVATE_CUSTODY_DETAIL'));owner.erase.mockRejectedValueOnce(Error('PRIVATE_CUSTODY_DETAIL'));
 expect(await location(()=>saveAgentFeedbackAction(packet()))).toBe('/assistant?error=feedback');expect(await location(eraseAgentFeedbackAction)).toBe('/assistant?ownClear=unavailable');
});
it('does not authenticate or write without an explicit closed consented rating',async()=>{
 const form=packet();form.delete('consented');expect(await location(()=>saveAgentFeedbackAction(form))).toBe('/assistant?error=feedback');expect(owner.session).not.toHaveBeenCalled();expect(owner.record).not.toHaveBeenCalled();
});
it('captures the original feedback selection before the session await',async()=>{
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;});
 owner.session.mockImplementationOnce(async()=>{entered();await resume;return ctx;});const form=packet(),pending=location(()=>saveAgentFeedbackAction(form));
 await ready;form.set('exchangeId','retargeted');form.set('outcome','incorrect');release();expect(await pending).toBe('/assistant');
 expect(owner.record).toHaveBeenCalledWith(ctx,{exchangeId:'original-exchange',outcome:'helpful',consented:true});
});
