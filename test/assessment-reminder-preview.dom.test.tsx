import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ReminderPersonPreview} from '../app/(app)/performance/onehr/reminder-person-preview';
const mocks=vi.hoisted(()=>({preview:vi.fn()}));
vi.mock('../app/(app)/performance/assessment-reminder-actions',()=>({assessmentReminderPersonPreviewAction:mocks.preview}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('full email preview and scoped task summary labels',()=>{
 it.each(['full','summary'] as const)('labels the %s mode and keeps the displayed HTML sandboxed without authorizing delivery',async mode=>{
  mocks.preview.mockResolvedValue({result:{mode,locale:mode==='full'?'ms':'en',eligible:false,employee:'Permitted label',employeeCode:'001',message:{subject:'Fictional subject',html:'<p>Fictional permitted preview</p>',text:'Fictional permitted preview'}}});
  render(<NextIntlClientProvider locale="en" messages={en}><ReminderPersonPreview cycleId="fixture-cycle"/></NextIntlClientProvider>);
  fireEvent.click(screen.getByText(en.onehr.reminders.personPreview,{selector:'summary'}));fireEvent.change(screen.getByLabelText(en.onehr.reminders.employeeId),{target:{value:'001'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.reminders.personPreview}));
  await screen.findByText(mode==='full'?en.onehr.reminders.previewFull.replace('{locale}','ms'):en.onehr.reminders.previewScoped);
  const iframe=screen.getByTitle(en.onehr.reminders.emailPreview);expect(iframe.getAttribute('sandbox')).toBe('');expect(iframe.getAttribute('srcdoc')).toBe('<p>Fictional permitted preview</p>');expect(screen.getByText(en.onehr.reminders.previewConsent)).toBeTruthy();expect(mocks.preview).toHaveBeenCalledExactlyOnceWith('fixture-cycle','001');
 });
});
