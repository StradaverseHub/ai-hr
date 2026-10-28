/** Authored UNRUN: unavailable preparation choices must not hide safe explicit metadata recovery. */
import type {ComponentProps} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {OwnLeaveCommandPanel} from '../components/assistant/own-leave-command-panel';
vi.mock('next/link',()=>({default:({children,...props}:ComponentProps<'a'>)=><a {...props}>{children}</a>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('empty own-leave preparation choices',()=>{
 it('disables preparation inputs and submit while retaining explicit own-metadata discovery without any automatic call',async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce(Response.json({kind:'review_index',reviews:[]}));vi.stubGlobal('fetch',fetchMock);
  const view=render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur"><OwnLeaveCommandPanel employments={[]} messages={en.ownLeaveReview.commands}/></NextIntlClientProvider>);
  const m=en.ownLeaveReview.commands;expect(fetchMock).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:m.prepare}) as HTMLButtonElement).disabled).toBe(true);expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
  const find=screen.getByRole('button',{name:m.findReviews}) as HTMLButtonElement;expect(find.disabled).toBe(false);fireEvent.click(find);await screen.findByText(m.noSavedReviews);
  expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][0]).toBe('/api/assistant/own-leave');expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({operation:'list'});expect(screen.queryByRole('button',{name:m.confirm})).toBeNull();
 });
});
