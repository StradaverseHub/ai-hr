import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({detail:vi.fn(),list:vi.fn()}));
vi.mock('../core/letters',()=>({getMyLetter:mocks.detail,listMyLetters:mocks.list}));
vi.mock('../lib/authz',()=>({requireModule:async()=>({})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fixture',userId:'signed-in-person'}})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>((key:string)=>key)}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');},redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
vi.mock('../app/(app)/me/letters/actions',()=>({openMyLetter:vi.fn(),confirmMyLetter:vi.fn()}));
import MyLetterPage from '../app/(app)/me/letters/[letterId]/page';
import MyLettersPage from '../app/(app)/me/letters/page';
const id='00000000-0000-4000-8000-000000000001',hash='c'.repeat(64);
const detail=()=>({record:{id,reference:'HR/2026/00001',state:'issued',issuedAt:new Date('2026-10-26T10:00:00Z')},artifact:{id:'artifact',contentHash:hash},acknowledgement:'acknowledge',events:[] as {kind:string;at:Date;contentHash:string}[]});
beforeEach(()=>{vi.clearAllMocks();mocks.detail.mockResolvedValue(detail());});afterEach(cleanup);
it('requires explicit intent and binds confirmation to the exact artifact while offering separate open/download actions',async()=>{
 render(await MyLetterPage({params:Promise.resolve({letterId:id}),searchParams:Promise.resolve({})}));expect(screen.getByRole('checkbox')).toHaveProperty('required',true);expect(screen.getByText('acknowledgementIntent')).toBeTruthy();expect(screen.getByRole('button',{name:'open'})).toBeTruthy();expect(screen.getByRole('button',{name:'download'})).toBeTruthy();expect(document.querySelector<HTMLInputElement>('input[name="artifactHash"]')!.value).toBe(hash);expect(mocks.detail).toHaveBeenCalledExactlyOnceWith({tenantId:'fixture',userId:'signed-in-person'},id);
});
it('renders revocation history without a download or acknowledgement form',async()=>{
 mocks.detail.mockResolvedValue({...detail(),record:{...detail().record,state:'void'}});render(await MyLetterPage({params:Promise.resolve({letterId:id}),searchParams:Promise.resolve({})}));expect(screen.getByText('voidHelp')).toBeTruthy();expect(screen.queryByRole('button',{name:'open'})).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();
});
it('shows a recorded confirmation without presenting a fresh confirmation action',async()=>{
 mocks.detail.mockResolvedValue({...detail(),events:[{kind:'acknowledged',at:new Date('2026-10-26T11:00:00Z'),contentHash:hash}]});render(await MyLetterPage({params:Promise.resolve({letterId:id}),searchParams:Promise.resolve({notice:'alreadyRecorded'})}));expect(screen.getByRole('status').textContent).toBe('alreadyRecorded');expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.getByText('acknowledged')).toBeTruthy();
});
it('does not render foreign letter information even for a privileged route caller',async()=>{
 mocks.detail.mockRejectedValue(new LetterWorkflowError('permission'));await expect(MyLetterPage({params:Promise.resolve({letterId:id}),searchParams:Promise.resolve({})})).rejects.toThrow('NOT_FOUND');
});
it('treats unknown error query values as plain unavailable feedback',async()=>{
 render(await MyLetterPage({params:Promise.resolve({letterId:id}),searchParams:Promise.resolve({error:'__proto__'})}));expect(screen.getByRole('alert').textContent).toBe('errors.unavailable');
});
it('keeps pending acknowledgement distinct from opening a new letter and paginates the personal list',async()=>{
 mocks.list.mockResolvedValue({rows:[{id,reference:'HR/2026/00001',state:'issued',issuedAt:new Date('2026-10-26T10:00:00Z'),acknowledgement:'acknowledge',viewed:false,confirmed:null}],nextCursor:id});render(await MyLettersPage({searchParams:Promise.resolve({})}));expect(screen.getByText('new')).toBeTruthy();expect(screen.getByText('pendingAcknowledgement')).toBeTruthy();expect(screen.getByRole('link',{name:'next'}).getAttribute('href')).toBe('/me/letters?cursor='+id);
});
