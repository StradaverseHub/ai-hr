import { describe,it,expect,vi } from 'vitest';
import { fireEvent,render,screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import messages from '../messages/en.json';
import { OnboardingNoteInput } from '../components/onboarding-note-input';
const ids=vi.fn();
function Note(){const [body,setBody]=useState(''),[mentions,setMentions]=useState<string[]>([]);return <NextIntlClientProvider locale="en" messages={messages}><OnboardingNoteInput label="Reply" body={body} mentions={mentions} directory={[{id:'authorized-person',name:'Fictional Colleague'}]} onChange={setBody} onMentions={value=>{ids(value);setMentions(value);}}/></NextIntlClientProvider>;}
describe('onboarding note mentions',()=>{
 it('resolves a typed mention through the authorized directory and supports removal',()=>{
  render(<Note/>);const input=screen.getByRole('textbox',{name:'Reply'});
  fireEvent.change(input,{target:{value:'Please confirm @Fictional',selectionStart:25}});
  fireEvent.click(screen.getByRole('option',{name:'Fictional Colleague'}));
  expect(ids).toHaveBeenLastCalledWith(['authorized-person']);
  expect(input).toHaveValue('Please confirm @Fictional Colleague ');
  fireEvent.click(screen.getByRole('button',{name:'Remove mention Fictional Colleague'}));
  expect(ids).toHaveBeenLastCalledWith([]);
 });
 it('does not invent a recipient for text that is absent from the directory',()=>{
  ids.mockClear();render(<Note/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Reply'}),{target:{value:'@Missing',selectionStart:8}});
  expect(screen.getByText('No colleagues match this mention.')).toBeVisible();
  expect(screen.queryByRole('option')).toBeNull();expect(ids).not.toHaveBeenCalled();
 });
});
