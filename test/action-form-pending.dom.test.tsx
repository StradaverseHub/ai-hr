import {afterEach,describe,expect,it} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ActionButton} from '@/components/ui/action-button';
import {ActionFormStatus} from '@/components/ui/action-form-status';
afterEach(cleanup);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
describe('real React mutation form pending ownership',()=>{
 it('tracks an implicit submit button until the action resolves',async()=>{
  const work=deferred();render(<form action={async()=>{await work.promise;}}><input name="reason" defaultValue="Keep this reason"/><ActionButton actionKind="saving">Save</ActionButton></form>);
  fireEvent.submit(screen.getByRole('button',{name:'Save'}).closest('form')!);await waitFor(()=>expect(screen.getByRole('button',{name:'Saving…'})).toBeDisabled());
  await act(async()=>work.resolve());await waitFor(()=>expect(screen.getByRole('button',{name:'Save'})).toBeEnabled());
 });
 it('keeps an externally positioned submit control busy through its own action form',async()=>{
  const work=deferred();render(<><form id="external-mutation" action={async()=>{await work.promise;}}><ActionFormStatus formId="external-mutation"/><input name="reason" defaultValue="Reason"/></form><ActionButton type="submit" form="external-mutation" actionKind="submitting">Confirm</ActionButton></>);
  fireEvent.submit(document.getElementById('external-mutation')!);await waitFor(()=>expect(screen.getByRole('button',{name:'Submitting…'})).toBeDisabled());
  await act(async()=>work.resolve());await waitFor(()=>expect(screen.getByRole('button',{name:'Confirm'})).toBeEnabled());
 });
});
