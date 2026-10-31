import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),save:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({saveLetterField:mocks.save}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {saveField} from '../app/(app)/letters/fields/actions';
const companyId='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',ctx={tenantId:'fixture',userId:'actual-user'};
function form(){const result=new FormData();for(const [key,value]of Object.entries({companyId,key:'letterSalary',label:'Letter salary',source:'compensation.basicSalary',kind:'text',description:'Canonical salary',active:'yes',expectedOrdinal:'2'}))result.set(key,value);return result;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);});
it('takes type and mandatory confidentiality from the allowlisted source and carries the version comparison',async()=>{
 mocks.save.mockResolvedValue({id,ordinal:3});await expect(saveField(null,form())).rejects.toThrow('REDIRECT:/letters/fields/'+id+'?notice=saved');expect(mocks.save).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,expectedOrdinal:2,active:true,definition:{key:'letterSalary',label:'Letter salary',description:'Canonical salary',source:'compensation.basicSalary',kind:'currency',required:false,editable:false,sensitive:true}});
});
it('does not accept arbitrary sources, missing version evidence or inherited object names',async()=>{
 for(const source of ['SELECT salary FROM compensation','__proto__','toString']){const data=form();data.set('source',source);expect(await saveField(null,data)).toEqual({error:'invalid'});}const data=form();data.delete('expectedOrdinal');expect(await saveField(null,data)).toEqual({error:'invalid'});expect(mocks.save).not.toHaveBeenCalled();
});
it('returns closed inline errors without echoing private diagnostics or clearing the form',async()=>{
 mocks.save.mockRejectedValue(new LetterWorkflowError('stale'));expect(await saveField(null,form())).toEqual({error:'stale'});mocks.save.mockRejectedValue(new Error('private SQL statement'));expect(await saveField(null,form())).toEqual({error:'unavailable'});expect(mocks.revalidate).not.toHaveBeenCalled();
});
