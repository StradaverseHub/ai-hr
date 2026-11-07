import {expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {render} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {FilterBar} from '../app/analytics/FilterBar';
import messages from '../messages/en.json';

it('ships a visible native POST submitter before hydration without changing normal GET fields or loading the workforce',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch');
 const selected={employmentId:'00000000-0000-0000-0000-000000050000',name:'Deep selected manager'};
 const html=renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}><FilterBar from="2026-01-01" to="2026-11-07" values={{managerEmploymentId:selected.employmentId}} managerSelection={selected} options={{companies:[],departments:[],costCentres:[],locations:[]}} preservedParams={{q:'legacy query',year:'2025',hirePage:'1999',carrySize:'all',unrecognized:'omit'}} /></NextIntlClientProvider>);
 const {container:root}=render(<div dangerouslySetInnerHTML={{__html:html}} />);
 const form=root.querySelector('form')!,browse=root.querySelector<HTMLButtonElement>('button[name="choiceContext"]')!;
 expect(form.method).toBe('get');expect(browse.hidden).toBe(false);expect(browse.closest('details')).toBeNull();expect(browse.type).toBe('submit');expect(browse.getAttribute('formaction')).toBe('/analytics/manager-choices');expect(browse.getAttribute('formmethod')).toBe('post');
 expect(root.querySelector('select[name="managerEmploymentId"] option:checked')?.textContent).toBe(selected.name);expect(root.querySelectorAll('select[name="managerEmploymentId"] option')).toHaveLength(2);
 const ordinary=new FormData(form);expect(ordinary.has('choiceContext')).toBe(false);expect(ordinary.has('managerQuery')).toBe(false);expect(root.querySelector('input[type="search"]')).not.toHaveAttribute('name');
 const native=new FormData(form,browse);expect(JSON.parse(String(native.get('choiceContext')))).toEqual({q:'legacy query',year:'2025',hirePage:'1999',carrySize:'all'});expect(native.get('managerEmploymentId')).toBe(selected.employmentId);expect(native.get('from')).toBe('2026-01-01');expect(native.get('to')).toBe('2026-11-07');
 // Exercise the browser's implicit Enter submitter on the unhydrated native markup.
 const submissions:HTMLButtonElement[]=[];
 form.addEventListener('submit',event=>{event.preventDefault();submissions.push((event as SubmitEvent).submitter as HTMLButtonElement);});
 const defaultSubmit=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
 expect(defaultSubmit).toHaveAttribute('tabindex','-1');expect(defaultSubmit).not.toHaveAttribute('name');expect(defaultSubmit).not.toHaveAttribute('formaction');expect(defaultSubmit).not.toHaveAttribute('formmethod');
 const user=userEvent.setup();root.querySelector<HTMLInputElement>('input[name="from"]')!.focus();await user.keyboard('{Enter}');
 expect(submissions).toEqual([defaultSubmit]);expect(new FormData(form,submissions[0]).has('choiceContext')).toBe(false);
 await user.click(browse);expect(submissions).toEqual([defaultSubmit,browse]);expect(new FormData(form,submissions[1]).has('choiceContext')).toBe(true);
 expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
});
