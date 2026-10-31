/** @vitest-environment jsdom */
/** Authored UNRUN. Explicit consent/reset and transport uncertainty; not server authority proof. */
import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
vi.mock('../app/(app)/assistant/native-outcome-actions',()=>({recordNativeOutcomeAction:vi.fn(async()=>{})}));
import {NativeOutcomeForm} from '../components/assistant/native-outcome-form';
afterEach(cleanup);
const props={jobId:'10000000-0000-4000-8000-000000000001',nonce:'10000000-0000-4000-8000-000000000002',options:[{value:'first',label:'Leave submitted; not approved'},{value:'second',label:'Claim submitted; not reimbursed'}],messages:{choose:'Choose completed action',consent:'I explicitly agree to link it',save:'Check and save',pending:'Checking',recover:'Reload saved links'}};
describe('human native outcome consent lifetime',()=>{
 it('starts without selection or consent, and changing a selected action clears prior consent',()=>{
  const{container}=render(<NativeOutcomeForm {...props}/>);const select=screen.getByRole('combobox'),consent=screen.getByRole('checkbox'),button=screen.getByRole('button');
  expect(consent).not.toBeChecked();expect(button).toBeDisabled();expect(container.querySelector<HTMLInputElement>('input[name="consented"]')?.value).toBe('no');
  fireEvent.change(select,{target:{value:'first'}});expect(button).toBeDisabled();fireEvent.click(consent);expect(button).toBeEnabled();
  fireEvent.change(select,{target:{value:'second'}});expect(consent).not.toBeChecked();expect(button).toBeDisabled();expect(container.querySelector<HTMLInputElement>('input[name="consented"]')?.value).toBe('no');
 });
 it('keeps exact successful fields when visible controls freeze after submission, without automatic retry',()=>{
  const{container}=render(<NativeOutcomeForm {...props}/>);fireEvent.change(screen.getByRole('combobox'),{target:{value:'first'}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.submit(container.querySelector('form')!);
  expect(screen.getByRole('combobox')).toBeDisabled();expect(screen.getByRole('checkbox')).toBeDisabled();expect(screen.getByRole('button')).toBeDisabled();expect(screen.getByRole('status')).toHaveTextContent('Checking');
  const submitted=new FormData(container.querySelector('form')!);expect(submitted.get('reference')).toBe('first');expect(submitted.get('consented')).toBe('yes');expect(submitted.get('nonce')).toBe(props.nonce);expect(submitted.get('jobId')).toBe(props.jobId);
  expect(screen.getByRole('link')).toHaveAttribute('href','/assistant?governed='+props.jobId);expect(container.querySelector('[name="eventId"],[name="personId"],[name="rating"]')).toBeNull();
 });
 it('prevents unchecked or double submission and uses a fresh key to retire old consent state',()=>{
  const{container,rerender}=render(<NativeOutcomeForm key="first" {...props}/>);const form=container.querySelector('form')!;expect(fireEvent.submit(form)).toBe(false);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'first'}});fireEvent.click(screen.getByRole('checkbox'));rerender(<NativeOutcomeForm key="fresh-render" {...props}/>);expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('combobox')).toHaveValue('');
 });
});
