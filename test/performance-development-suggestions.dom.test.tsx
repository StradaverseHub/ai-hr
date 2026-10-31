import React from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({suggest:vi.fn(),apply:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({developmentSuggestionsAction:ports.suggest,applyDevelopmentSuggestionsAction:ports.apply}));
import { DevelopmentSuggestions } from '../app/(app)/performance/onehr/development-suggestions';
const goal=(area:string)=>({area,title:area,itemIds:['tc:0'],onJob:'Lead a practical assignment',fromOthers:'Ask for mentor feedback',formalLearning:'Study the method'});
function show(){render(<NextIntlClientProvider locale="en" messages={en}><form><input type="hidden" name="reviewId" value="review"/><label>Aspiration<input name="aspiration" defaultValue="My saved aspiration"/></label><DevelopmentSuggestions reviewId="review"/></form></NextIntlClientProvider>);}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('previews suggestions without writing and carries unsaved form words when the human applies only kept goals',async()=>{
 ports.suggest.mockResolvedValue({goals:[goal('Planning'),goal('Facilitation')],pool:[{id:'tc:0',label:'Planning',note:'not demonstrated',kind:'technical'}],sourceDigest:'digest',remaining:4,limit:5,empty:false,stretchOnly:false});ports.apply.mockResolvedValue({ok:true});show();
 fireEvent.change(screen.getByLabelText('Aspiration'),{target:{value:'My unsaved aspiration'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.developmentSuggestions.generate}));
 expect(await screen.findByRole('checkbox',{name:'Planning'})).toBeTruthy();expect(ports.apply).not.toHaveBeenCalled();expect(ports.refresh).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('checkbox',{name:'Facilitation'}));fireEvent.click(screen.getByRole('button',{name:'Add selected to draft (1)'}));
 await waitFor(()=>expect(ports.apply).toHaveBeenCalledOnce());const [form,selected,digest]=ports.apply.mock.calls[0];expect(form.get('aspiration')).toBe('My unsaved aspiration');expect(selected).toEqual([goal('Planning')]);expect(digest).toBe('digest');await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());
});
it('keeps proposals on an apply error, can discard without a write and explains the empty source',async()=>{
 ports.suggest.mockResolvedValueOnce({goals:[goal('Planning')],pool:[{id:'tc:0',label:'Planning',note:'next level',kind:'technical'}],sourceDigest:'digest',remaining:4,limit:5,empty:false,stretchOnly:true}).mockResolvedValueOnce({goals:[],pool:[],sourceDigest:'empty',remaining:4,limit:5,empty:true,stretchOnly:false});ports.apply.mockResolvedValue({error:'The plan changed.'});show();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.developmentSuggestions.generate}));await screen.findByRole('checkbox',{name:'Planning'});fireEvent.click(screen.getByRole('button',{name:'Add selected to draft (1)'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','The plan changed.');expect(screen.getByRole('checkbox',{name:'Planning'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.developmentSuggestions.discard}));expect(screen.queryByRole('checkbox')).toBeNull();expect(ports.refresh).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.developmentSuggestions.generate}));expect(await screen.findByText(en.onehr.developmentSuggestions.empty)).toBeTruthy();expect(screen.queryByRole('button',{name:/Add selected/})).toBeNull();expect(ports.apply).toHaveBeenCalledOnce();
});

it('shows the current daily allowance on entry and disables generation at zero before any request',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><form><DevelopmentSuggestions reviewId="review" initialQuota={{remaining:0,limit:5}}/></form></NextIntlClientProvider>);
 expect((screen.getByRole('button',{name:en.onehr.developmentSuggestions.generate}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('status').textContent).toContain('0 of 5');expect(ports.suggest).not.toHaveBeenCalled();
});
