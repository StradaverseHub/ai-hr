/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {useState} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {ProtectedInputHelp} from '../components/assistant/protected-input-help';
afterEach(cleanup);
it.each(Object.entries({en,ms,zh,ta,th,vi:viCopy}))('%s offers a locally editable explicit rule without sending or submitting it',(_locale,messages)=>{
 const submit=vi.fn();function Entry(){const [value,setValue]=useState('');return <form onSubmit={event=>{event.preventDefault();submit();}}><label>Input<textarea value={value} onChange={event=>setValue(event.target.value)}/></label><ProtectedInputHelp kind="payRule" onChoose={setValue}/></form>;}
 render(<NextIntlClientProvider locale={_locale} messages={messages}><Entry/></NextIntlClientProvider>);
 expect(screen.getByText(messages.assistant.protectedInput.payRule)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'10% of basic'}));expect(screen.getByRole('textbox')).toHaveValue('10% of basic');
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'12.5% of basic'}});expect(screen.getByRole('textbox')).toHaveValue('12.5% of basic');expect(submit).not.toHaveBeenCalled();
});
it('only offers source-provided report column choices and never dispatches on selection',()=>{
 const choose=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><ProtectedInputHelp kind="report" onChoose={choose} choices={['columns: employeeCode, company']}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'columns: employeeCode, company'}));expect(choose).toHaveBeenCalledExactlyOnceWith('columns: employeeCode, company');expect(screen.getAllByRole('button')).toHaveLength(1);
});
it('describes layout as retaining the original words and exposes only closed layouts',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><ProtectedInputHelp kind="layout" onChoose={vi.fn()}/></NextIntlClientProvider>);
 expect(screen.getByText(en.assistant.protectedInput.layout)).toBeInTheDocument();expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['format as a paragraph','format as bullets']);
 expect(en.onehr.rewrite.title).toBe('Format my words');expect(en.reports.ai.title).toBe('Arrange selected report columns');expect(en.payRule.assistTitle).toBe('Choose a pay-rule template');
});
