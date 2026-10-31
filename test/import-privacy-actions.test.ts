/** Mocked command boundary, not actual identity/RLS erasure proof. The store DB suite owns that. */
import {beforeEach,expect,it,vi} from 'vitest';
const boundary=vi.hoisted(()=>({session:vi.fn(),erase:vi.fn()}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:boundary.session}));
vi.mock('../core/personnel-import-evaluation',()=>({eraseOwnImportEvaluationMetadata:boundary.erase}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(location:string)=>{throw Object.assign(Error('fixture navigation'),{location});}}));
import {eraseImportPreparationHistoryAction} from '../app/(app)/assistant/import-privacy-actions';
const ctx={tenantId:'fixture-tenant',userId:'fixture-user',roles:[],grants:[]};
beforeEach(()=>{boundary.session.mockReset();boundary.erase.mockReset();boundary.session.mockResolvedValue(ctx);});
async function location(){try{await eraseImportPreparationHistoryAction();throw Error('Expected navigation');}catch(error){const value=(error as {location?:unknown}).location;if(typeof value!=='string')throw error;return value;}}
it('bounds authentication failure without invoking any data owner',async()=>{boundary.session.mockRejectedValueOnce(Error('PRIVATE_AUTH_DIAGNOSTIC'));expect(await location()).toBe('/assistant?importHistory=unavailable#assistant-privacy');expect(boundary.erase).not.toHaveBeenCalled();});
it('forwards only the actual current identity, including a login with no business grants',async()=>{expect(await location()).toBe('/assistant?importHistory=erased#assistant-privacy');expect(boundary.erase).toHaveBeenCalledWith(ctx);expect(boundary.erase).toHaveBeenCalledOnce();});
it('bounds storage failure without returning private SQL or claiming erasure',async()=>{boundary.erase.mockRejectedValueOnce(Error('PRIVATE_SQL_OR_SOURCE'));expect(await location()).toBe('/assistant?importHistory=unavailable#assistant-privacy');});
