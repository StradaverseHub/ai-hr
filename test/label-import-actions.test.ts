import {beforeEach,describe,expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({admin:vi.fn(async()=>({s:{tenantId:'fictional'}})),preview:vi.fn(),apply:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:calls.admin}));vi.mock('next/cache',()=>({revalidatePath:calls.revalidate}));
vi.mock('../core/system-label-import',()=>({previewSystemLabelImport:calls.preview}));
// The confirmed import starts the background job (core/system-label-import-job.ts); its intent is always add-only.
vi.mock('../core/system-label-import-job',()=>({startSystemLabelImportJob:calls.apply,SystemLabelImportJobError:class extends Error{}}));
import {previewLabelsAction,importLabelsAction} from '../app/admin/settings/system-labels/import-actions';
beforeEach(()=>{vi.clearAllMocks();calls.preview.mockResolvedValue({token:'t',rows:[],valid:false,mode:'add'});calls.apply.mockResolvedValue({job:{id:'fictional-job',state:'queued'},existing:false});});
const data=(mode:string,name='fixture.xls',size=1)=>{const data=new FormData();data.set('file',new File([new Uint8Array(size)],name));data.set('mode',mode);data.set('confirmUpdates','true');data.set('token','t');return data;};
describe('server-owned Labels import intent',()=>{
 it.each(['add','update','merge','forged'])('ignores forged legacy %s mode and update confirmation for both public actions',async mode=>{
  expect((await previewLabelsAction(data(mode))).ok).toBe(true);expect(calls.preview.mock.calls[0][2]).toBe('add');
  expect((await importLabelsAction(data(mode))).ok).toBe(true);expect(calls.apply.mock.calls[0][1]).toMatchObject({token:'t'});
  expect(calls.apply.mock.calls[0][1]).not.toHaveProperty('mode');expect(calls.apply.mock.calls[0][1]).not.toHaveProperty('confirmUpdates');
 });
 it('enforces actual file admission before the canonical parser and does not revalidate on refusal',async()=>{
  for(const input of [data('add','fake.csv'),data('add','too-big.xlsx',5_000_001),data('add','empty.xls',0)]){
   expect((await importLabelsAction(input)).ok).toBe(false);
  }
  expect(calls.apply).not.toHaveBeenCalled();expect(calls.revalidate).not.toHaveBeenCalled();
 });
});
