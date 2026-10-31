import React,{useState} from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr/draft-form',()=>({flushAssessmentDrafts:vi.fn().mockResolvedValue(undefined)}));
import { RewriteField } from '../app/(app)/performance/onehr/rewrite-field';
afterEach(cleanup);
const original='I completed the agreed delivery.',proposed='I completed the delivery as agreed.';
const response=()=>vi.fn().mockResolvedValue({text:proposed,remaining:4,limit:5,resetSeconds:0});
function show(action=response(),enabled=true){
 const submitted=vi.fn();
 render(<NextIntlClientProvider locale="en" messages={en}><form onSubmit={submitted}><RewriteField enabled={enabled} target={{kind:'pm_self_remark'}} rewriteAction={action}><label>Evidence wording<textarea defaultValue={original}/></label></RewriteField></form></NextIntlClientProvider>);
 return {action,submitted};
}
it('keeps drafting separate from the actual field until the person explicitly keeps the suggestion',async()=>{
 const {action,submitted}=show();const input=screen.getByRole('textbox',{name:'Evidence wording'}) as HTMLTextAreaElement;
 fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.title}));
 fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.generate}));
 expect(await screen.findByRole('textbox',{name:en.onehr.rewrite.suggestion})).toBeTruthy();expect(input.value).toBe(original);
 expect(action).toHaveBeenCalledWith({kind:'pm_self_remark'},original,'format as a paragraph',expect.any(String));
 await waitFor(()=>expect((screen.getByRole('button',{name:en.onehr.rewrite.keep}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.keep}));expect(input.value).toBe(proposed);expect(submitted).not.toHaveBeenCalled();
});
it('leaves the original words intact when the person discards a draft and hides AI controls when switched off',async()=>{
 show();fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.title}));fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.generate}));await screen.findByRole('textbox',{name:en.onehr.rewrite.suggestion});
 fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.discard}));expect((screen.getByRole('textbox',{name:'Evidence wording'}) as HTMLTextAreaElement).value).toBe(original);
 cleanup();show(response(),false);expect(screen.queryByRole('button',{name:en.onehr.rewrite.title})).toBeNull();expect(screen.getByRole('textbox',{name:'Evidence wording'})).toBeTruthy();
});
it('refuses to overwrite a field that changed while a suggestion was being prepared',async()=>{
 show();const field=screen.getByRole('textbox',{name:'Evidence wording'});fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.title}));fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.generate}));await screen.findByRole('textbox',{name:en.onehr.rewrite.suggestion});
 fireEvent.input(field,{target:{value:'My newer wording.'}});await waitFor(()=>expect((screen.getByRole('button',{name:en.onehr.rewrite.keep}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.keep}));
 expect(screen.getByRole('alert').textContent).toBe(en.onehr.rewrite.changed);expect((field as HTMLTextAreaElement).value).toBe('My newer wording.');
});
it('propagates the kept wording to a controlled form field and its autosave input listener',async()=>{
 const input=vi.fn(),action=response();
 function Controlled(){const [value,setValue]=useState(original);return <RewriteField enabled target={{kind:'pm_self_remark'}} rewriteAction={action}><label>Controlled wording<textarea value={value} onInput={input} onChange={event=>setValue(event.target.value)}/></label><output>{value}</output></RewriteField>;}
 render(<NextIntlClientProvider locale="en" messages={en}><Controlled/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.title}));fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.generate}));await screen.findByRole('textbox',{name:en.onehr.rewrite.suggestion});await waitFor(()=>expect((screen.getByRole('button',{name:en.onehr.rewrite.keep}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:en.onehr.rewrite.keep}));
 expect(screen.getByRole('status').textContent).toBe(proposed);expect(input).toHaveBeenCalledOnce();expect((screen.getByRole('textbox',{name:'Controlled wording'}) as HTMLTextAreaElement).value).toBe(proposed);
});
