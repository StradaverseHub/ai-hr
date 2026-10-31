import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {RevertControl} from '../app/(app)/payroll/history-import/logs/[attemptId]/revert-control';
const mocks=vi.hoisted(()=>({preview:vi.fn(),revert:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/(app)/payroll/history-import/workflow-actions',()=>({previewHistoryRevertAction:mocks.preview,revertHistoryUploadAction:mocks.revert}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
const hash='a'.repeat(64);
const catalogues={en,ms,zh,ta,th,vi:viMessages};
function show(locale:keyof typeof catalogues='en'){
 const messages=catalogues[locale];render(<NextIntlClientProvider locale={locale} messages={messages}><RevertControl attemptId="attempt-a" count={2}/></NextIntlClientProvider>);return messages.payroll.historyRevisions;
}
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe('payroll history eligibility and exact recovery confirmation',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('requires eligibility and explicit consent before recovery in %s',async locale=>{
  const user=userEvent.setup();mocks.preview.mockResolvedValue({ok:true,result:{attemptId:'attempt-a',count:2,previewHash:hash}});mocks.revert.mockResolvedValue({ok:true,result:{restored:2}});
  const t=show(locale);expect(screen.queryByRole('checkbox')).toBeNull();await user.click(screen.getByRole('button',{name:t.reviewRevert}));expect(mocks.preview).toHaveBeenCalledExactlyOnceWith('attempt-a');
  const revert=screen.getByRole('button',{name:t.revert});expect(revert).toBeDisabled();await user.click(screen.getByRole('checkbox'));expect(revert).toBeEnabled();await user.click(revert);
  expect(mocks.revert).toHaveBeenCalledExactlyOnceWith('attempt-a',hash);expect(mocks.refresh).toHaveBeenCalledOnce();
 });
 it('blocks recovery for an ineligible or changed set without exposing a confirmation',async()=>{
  const user=userEvent.setup();mocks.preview.mockResolvedValueOnce({ok:false,error:'A later correction changed this record.'}).mockResolvedValueOnce({ok:true,result:{count:1,previewHash:hash}});const t=show();
  await user.click(screen.getByRole('button',{name:t.reviewRevert}));expect(screen.getByRole('alert')).toHaveTextContent('A later correction');expect(screen.queryByRole('checkbox')).toBeNull();
  await user.click(screen.getByRole('button',{name:t.reviewRevert}));expect(screen.getByRole('alert')).toHaveTextContent(t.revertChanged);expect(screen.queryByRole('checkbox')).toBeNull();expect(mocks.revert).not.toHaveBeenCalled();
 });
 it('disables duplicate review while pending and requires a new review after a failed recovery',async()=>{
  const user=userEvent.setup();let resolve!:(value:unknown)=>void;mocks.preview.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));mocks.revert.mockResolvedValue({ok:false,error:'A statutory report now depends on this history.'});const t=show();
  await user.click(screen.getByRole('button',{name:t.reviewRevert}));expect(screen.getByRole('button',{name:t.working})).toBeDisabled();expect(mocks.preview).toHaveBeenCalledOnce();
  resolve({ok:true,result:{count:2,previewHash:hash}});await screen.findByRole('checkbox');await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:t.revert}));
  expect(screen.getByRole('alert')).toHaveTextContent('statutory report');expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.getByRole('button',{name:t.reviewRevert})).toBeEnabled();expect(mocks.refresh).not.toHaveBeenCalled();
  mocks.preview.mockResolvedValue({ok:true,result:{count:2,previewHash:'b'.repeat(64)}});await user.click(screen.getByRole('button',{name:t.reviewRevert}));expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:t.revert})).toBeDisabled();
 });
 it('clears the reviewed revision and consent on cancellation',async()=>{
  const user=userEvent.setup();mocks.preview.mockResolvedValue({ok:true,result:{count:2,previewHash:hash}});const t=show();await user.click(screen.getByRole('button',{name:t.reviewRevert}));await user.click(screen.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:t.cancel}));
  expect(screen.queryByRole('checkbox')).toBeNull();await user.click(screen.getByRole('button',{name:t.reviewRevert}));expect(mocks.preview).toHaveBeenCalledTimes(2);expect(screen.getByRole('checkbox')).not.toBeChecked();expect(mocks.revert).not.toHaveBeenCalled();
 });
});
