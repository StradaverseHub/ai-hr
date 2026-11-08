import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {SystemLabelExportButton} from '../components/system-label-export-button';
import {SystemLabelScope} from '../components/system-label-scope';
import {LABEL_IMPORT_DEFINITIONS} from '../lib/system-label-definition';
import en from '../messages/en.json';import zh from '../messages/zh.json';import ms from '../messages/ms.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const fetchMock=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('System Labels Excel download controls',()=>{
 it.each([['en',en],['zh',zh],['ms',ms],['ta',ta],['th',th],['vi',viMessages]] as const)('renders translated Export and scope for all 23 categories in %s',(locale,messages)=>{
  render(<NextIntlClientProvider locale={locale} messages={messages} onError={e=>{throw e;}}>{LABEL_IMPORT_DEFINITIONS.map(d=><SystemLabelExportButton key={d.kind} kind={d.kind}/>)}<SystemLabelScope ids={null}/><SystemLabelScope ids={['a','b']}/></NextIntlClientProvider>);
  expect(screen.getAllByRole('button',{name:messages.systemLabelExchange.export})).toHaveLength(23);
  expect(screen.getByText(messages.systemLabelExchange.global)).toBeTruthy();
 });
 it('disables Export while downloading, shows a safe error and allows retry',async()=>{
  let reject!:(reason:Error)=>void;fetchMock.mockImplementationOnce(()=>new Promise((_,no)=>{reject=no;}));
  render(<NextIntlClientProvider locale="en" messages={en}><SystemLabelExportButton kind="religion"/></NextIntlClientProvider>);
  await userEvent.click(screen.getByRole('button',{name:'Export'}));
  expect(screen.getByRole('button',{name:'Exporting…'}).hasAttribute('disabled')).toBe(true);
  expect(fetchMock).toHaveBeenCalledWith('/admin/settings/system-labels/current-data?kind=religion&inactive=1',{cache:'no-store'});
  reject(new Error('private database credentials must not reach the screen'));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe(en.systemLabelExchange.failed));
  expect(screen.getByRole('button',{name:'Export'}).hasAttribute('disabled')).toBe(false);
  expect(screen.queryByText(/credentials/)).toBeNull();
 });
 it('refuses an HTML sign-in response instead of downloading it as an Excel file',async()=>{
  fetchMock.mockResolvedValue({ok:true,headers:new Headers({'Content-Type':'text/html'}),blob:vi.fn()});
  render(<NextIntlClientProvider locale="en" messages={en}><SystemLabelExportButton kind="grades"/></NextIntlClientProvider>);
  await userEvent.click(screen.getByRole('button',{name:'Export'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe(en.systemLabelExchange.failed));
 });
});
