import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { AttendanceSubmissionForm, AttendanceSubmissionButton } from '../components/attendance-submission-form';
afterEach(cleanup);
function Fixture({action}:{action:(data:FormData)=>Promise<void|{error:string}>}){
 return <NextIntlClientProvider locale="en" messages={en}><AttendanceSubmissionForm action={action}>
  <input aria-label="Reason" name="reason" defaultValue=""/><input aria-label="Attachment" name="attachment" type="file"/>
  <AttendanceSubmissionButton>Submit</AttendanceSubmissionButton>
 </AttendanceSubmissionForm></NextIntlClientProvider>;
}
it('retains entered text and the selected attachment after missing-route refusal, then permits retry',async()=>{
 const action=vi.fn(async()=>({error:'Please Contact the HR Administrator.'}));render(<Fixture action={action}/>);
 const reason=screen.getByRole('textbox',{name:'Reason'}),attachment=screen.getByLabelText('Attachment') as HTMLInputElement;
 fireEvent.change(reason,{target:{value:'Missing clock out'}});const file=new File(['proof'],'proof.png',{type:'image/png'});
 fireEvent.change(attachment,{target:{files:[file]}});fireEvent.submit(reason.closest('form')!);
 expect(await screen.findByRole('alert')).toHaveTextContent('Please Contact the HR Administrator.');
 expect(reason).toHaveValue('Missing clock out');expect(attachment.files?.[0]).toBe(file);
 expect(screen.getByRole('button',{name:'Submit'})).toBeEnabled();
 fireEvent.submit(reason.closest('form')!);await waitFor(()=>expect(action).toHaveBeenCalledTimes(2));
});
it('closes the duplicate-submit gap before a transition rerenders and disables the active form',async()=>{
 let finish!:(value:{error:string})=>void;
 const action=vi.fn(()=>new Promise<{error:string}>(resolve=>{finish=resolve}));render(<Fixture action={action}/>);
 const form=screen.getByRole('textbox',{name:'Reason'}).closest('form')!;
 await act(async()=>{fireEvent.submit(form);fireEvent.submit(form);});
 expect(action).toHaveBeenCalledTimes(1);expect(screen.getByRole('button')).toBeDisabled();
 await act(async()=>finish({error:'Please Contact the HR Administrator.'}));
 expect(await screen.findByRole('button',{name:'Submit'})).toBeEnabled();
});
it('does not turn an ordinary transport failure into a success or expose its private message',async()=>{
 const action=vi.fn(async()=>{throw Error('private connection detail')});render(<Fixture action={action}/>);
 fireEvent.submit(screen.getByRole('textbox',{name:'Reason'}).closest('form')!);
 expect(await screen.findByRole('alert')).not.toHaveTextContent('private connection detail');
 expect(screen.getByRole('button',{name:'Submit'})).toBeEnabled();
});
it('keeps a framework-handled successful redirect out of the error state',async()=>{
 const action=vi.fn(async()=>{throw Object.assign(Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;push;/attendance/requests;303;',handled:true})});render(<Fixture action={action}/>);
 fireEvent.submit(screen.getByRole('textbox',{name:'Reason'}).closest('form')!);
 await waitFor(()=>expect(action).toHaveBeenCalledTimes(1));expect(screen.queryByRole('alert')).toBeNull();
});
