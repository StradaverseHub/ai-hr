import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NoticeAttachmentEditor,type NoticeAttachmentEditorLabels} from '../components/notice/attachment-editor';
vi.mock('next-intl',()=>({useLocale:()=> 'en'}));
const labels:NoticeAttachmentEditorLabels={title:'Attachments',help:'Up to five files',choose:'Choose file',add:'Add file',pending:'Uploading',remove:'Remove',saveFirst:'Save a draft first',saveHint:'Save the notice to include these files',file:'Check file type',tooLarge:'File is too large or empty',changed:'Reload the changed notice',limit:'Five files maximum',unavailable:'Notice unavailable',failed:'Please try again'};
const props=()=>({noticeId:'notice',contentVersion:2,items:[],onUploaded:vi.fn(),onRemove:vi.fn(),onBusyChange:vi.fn(),labels});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));
describe('Notice editor staged file selection',()=>{
 it('keeps file bytes out of the parent save and blocks its save contract until upload or cancellation',()=>{
  const p=props();render(<form aria-label="Notice"><NoticeAttachmentEditor {...p}/></form>);
  fireEvent.change(screen.getByLabelText(labels.choose),{target:{files:[new File(['Fictional'],'fictional.txt')]}});
  expect(p.onBusyChange).toHaveBeenLastCalledWith(true);
  expect([...new FormData(screen.getByRole('form') as HTMLFormElement).entries()]).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:labels.remove}));expect(p.onBusyChange).toHaveBeenLastCalledWith(false);expect(fetch).not.toHaveBeenCalled();
 });
 it('submits one stable intent through repeated clicks, returns metadata and requires the explicit parent save',async()=>{
  let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});vi.mocked(fetch).mockReturnValue(pending as Promise<Response>);
  const p=props();render(<NoticeAttachmentEditor {...p}/>);const file=new File(['Fictional'],'fictional.txt');
  fireEvent.change(screen.getByLabelText(labels.choose),{target:{files:[file]}});fireEvent.click(screen.getByRole('button',{name:labels.add}));
  await waitFor(()=>expect(screen.getByRole('button',{name:labels.pending})).toBeDisabled());fireEvent.click(screen.getByRole('button',{name:labels.pending}));expect(fetch).toHaveBeenCalledTimes(1);
  const request=vi.mocked(fetch).mock.calls[0][1]!,data=request.body as FormData;expect(data.get('contentVersion')).toBe('2');expect((data.get('file') as File).name).toBe('fictional.txt');expect(String(data.get('uploadKey'))).toMatch(/^[0-9a-f-]{36}$/);
  const attachment={id:'asset',fileName:'fictional.txt',mimeType:'text/plain',byteLength:9};
  await act(async()=>finish({ok:true,json:async()=>({attachment})}));
  expect(p.onUploaded).toHaveBeenCalledWith(attachment);expect(p.onBusyChange).toHaveBeenLastCalledWith(false);expect(screen.getByRole('status').textContent).toBe(labels.saveHint);
 });
 it('retains the selected upload intent on a failed response and displays only safe localized wording',async()=>{
  vi.mocked(fetch).mockResolvedValue({ok:false,json:async()=>({error:'changed',details:'PRIVATE SERVER DETAIL'})} as Response);
  render(<NoticeAttachmentEditor {...props()}/>);fireEvent.change(screen.getByLabelText(labels.choose),{target:{files:[new File(['Fictional'],'fictional.txt')]}});fireEvent.click(screen.getByRole('button',{name:labels.add}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe(labels.changed));
  const first=vi.mocked(fetch).mock.calls[0][1]!.body as FormData;fireEvent.click(screen.getByRole('button',{name:labels.add}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));const second=vi.mocked(fetch).mock.calls[1][1]!.body as FormData;expect(second.get('uploadKey')).toBe(first.get('uploadKey'));
  expect(document.body.textContent).not.toContain('PRIVATE SERVER DETAIL');
 });
});
