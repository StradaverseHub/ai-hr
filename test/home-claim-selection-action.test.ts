import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:{userId:'login',personId:'own-person'},legacy:vi.fn(),own:vi.fn(),submit:vi.fn(),save:vi.fn(),bulk:vi.fn(),remove:vi.fn(),cancel:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/read',()=>({myEmployment:state.legacy,myOwnEmploymentSubjects:state.own}));
vi.mock('../packs/claims/service',()=>({submitClaimWithAttachment:state.submit,saveClaimDraft:state.save,submitDraftClaims:state.bulk,deleteClaimDraft:state.remove,cancelClaim:state.cancel}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw Error('redirect:'+url);}}));vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
import {submitClaimAction,submitDraftsAction,deleteDraftAction,cancelClaimAction} from '../app/claims/actions';
const own='5b9c9f7f-bd09-4d8d-a34d-201b1abf79e2';
function form(){const value=new FormData();for(const [key,val] of Object.entries({employmentId:own,claimTypeId:'type',amount:'10',incurredOn:'2025-01-01',description:'Fictional claim'}))value.set(key,val);return value;}
beforeEach(()=>{vi.clearAllMocks();state.own.mockResolvedValue([{employmentId:own,personName:'Fictional owner',company:'Second employer',employeeCode:'B'}]);state.legacy.mockResolvedValue({employmentId:'legacy-first'});state.bulk.mockResolvedValue({submitted:1});});
describe('Home claim selected employment at the server action',()=>{
 it('submits for the selected second own employment and preserves the return selector',async()=>{
  await expect(submitClaimAction({error:null},form())).rejects.toThrow('employmentId='+own);
  expect(state.submit).toHaveBeenCalledWith(state.session,expect.objectContaining({employmentId:own}),null);expect(state.legacy).not.toHaveBeenCalled();
 });
 it('saves and files the same selected draft through canonical owners',async()=>{
  const data=form();data.set('draftId','draft');await expect(submitClaimAction({error:null},data)).rejects.toThrow('employmentId='+own);
  expect(state.save).toHaveBeenCalledWith(state.session,expect.objectContaining({id:'draft',employmentId:own}),null);expect(state.bulk).toHaveBeenCalledWith(state.session,{ids:['draft'],employmentId:own});
 });
 it.each(['','foreign','016b74cd-734f-40a1-8284-09f1e788d96a'])('refuses unavailable %s before attachment bytes or writes',async employmentId=>{
  const data=form();data.set('employmentId',employmentId);const file=new File(['%PDF-fictional'],'fictional.pdf',{type:'application/pdf'});data.set('receipt',file);const bytes=vi.spyOn(File.prototype,'arrayBuffer');
  try{expect(await submitClaimAction({error:null},data)).toEqual({error:'No active employment is linked to your account.'});expect(bytes).not.toHaveBeenCalled();}finally{bytes.mockRestore();}
  expect(state.legacy).not.toHaveBeenCalled();expect(state.submit).not.toHaveBeenCalled();expect(state.save).not.toHaveBeenCalled();
 });
 it('refuses repeated selectors instead of treating absence as the first own employment',async()=>{const data=form();data.append('employmentId',own);expect((await submitClaimAction({error:null},data)).error).toBeTruthy();expect(state.submit).not.toHaveBeenCalled();expect(state.legacy).not.toHaveBeenCalled();});
 it('keeps legacy no-selector submissions on their established course',async()=>{const data=form();data.delete('employmentId');await expect(submitClaimAction({error:null},data)).rejects.toThrow('toast=Claim+submitted');expect(state.submit).toHaveBeenCalledWith(state.session,expect.objectContaining({employmentId:'legacy-first'}),null);});
 it.each([[submitDraftsAction,'bulk'],[deleteDraftAction,'remove'],[cancelClaimAction,'cancel']] as const)('binds list mutations and return navigation to the same selected subject',async(action,kind)=>{
  const data=form();data.set('id','record');data.append('draftIds','record');await expect(action(data)).rejects.toThrow('employmentId='+own);
  if(kind==='bulk')expect(state.bulk).toHaveBeenCalledWith(state.session,{ids:['record'],employmentId:own});else expect(state[kind]).toHaveBeenCalledWith(state.session,'record',own);
 });
 it('binds cancellation without a posted selector to the caller’s resolved own employment',async()=>{
  const data=form();data.delete('employmentId');data.set('id','claim');await expect(cancelClaimAction(data)).rejects.toThrow('toast=Claim+cancelled');
  expect(state.cancel).toHaveBeenCalledWith(state.session,'claim','legacy-first');
 });
 it('refuses an unposted cancellation when there is no linked own employment, before calling the native service',async()=>{
  state.legacy.mockResolvedValue(null);const data=form();data.delete('employmentId');data.set('id','other-person-claim');
  await expect(cancelClaimAction(data)).rejects.toThrow('error=No+active+employment');expect(state.cancel).not.toHaveBeenCalled();
 });
 it('refuses a foreign posted employment on cancellation before calling the native service',async()=>{
  const data=form();data.set('employmentId','016b74cd-734f-40a1-8284-09f1e788d96a');data.set('id','other-person-claim');
  await expect(cancelClaimAction(data)).rejects.toThrow('error=No+active+employment');expect(state.cancel).not.toHaveBeenCalled();
 });

});
