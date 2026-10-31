/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({more:vi.fn()}));
vi.mock('../app/(app)/assistant/launcher-actions',()=>({loadMoreChatsAction:ports.more}));
vi.mock('next/link',()=>({default:({children,scroll,...props}:any)=><a {...props}>{children}</a>}));
import {SavedChatList} from '../components/assistant/saved-chat-list';
const copy=en.assistant.workspace.chat;
beforeEach(()=>ports.more.mockReset());afterEach(cleanup);
it('deduplicates a long chat across scan pages while preserving its newest selected tail and other chats',async()=>{
 ports.more.mockResolvedValueOnce({ok:true,chats:[{threadId:'thread',exchangeId:'older-tail',title:'Same long chat'},{threadId:'other',exchangeId:'other-tail',title:'Another chat'}],nextCursor:null,scopeDigest:'scope'});
 render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={[{threadId:'thread',exchangeId:'newest-tail',title:'Same long chat'}]} nextCursor="page-2" scopeDigest="scope" newChatHref="/assistant?chatReset=new"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:copy.moreChats}));await screen.findByRole('link',{name:'Another chat'});
 expect(screen.getAllByRole('link',{name:'Same long chat'})).toHaveLength(1);expect(screen.getByRole('link',{name:'Same long chat'})).toHaveAttribute('href','/assistant?e=newest-tail');expect(screen.queryByRole('button',{name:copy.moreChats})).toBeNull();expect(ports.more).toHaveBeenCalledExactlyOnceWith({cursor:'page-2'});
});
it('discards a page from a different scope without mixing its titles into the current sidebar',async()=>{
 ports.more.mockResolvedValueOnce({ok:true,chats:[{threadId:'foreign',exchangeId:'foreign-tail',title:'OTHER_SCOPE_TITLE'}],nextCursor:null,scopeDigest:'other-scope'});
 render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={[]} nextCursor="page" scopeDigest="scope" newChatHref="/assistant?chatReset=new"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:copy.moreChats}));await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(copy.readOnlyHistory));expect(screen.queryByText('OTHER_SCOPE_TITLE')).toBeNull();
});

it('drops old accumulated titles when an authoritative history refresh reports erasure',async()=>{
 ports.more.mockResolvedValueOnce({ok:true,chats:[{threadId:'old-page',exchangeId:'old-page-tail',title:'ERASED_PAGED_TITLE'}],nextCursor:null,scopeDigest:'scope'});
 const props={nextCursor:'page-2',scopeDigest:'scope',newChatHref:'/assistant?chatReset=new'};
 const view=render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList {...props} initialChats={[{threadId:'first',exchangeId:'first-tail',title:'ERASED_FIRST_TITLE'}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:copy.moreChats}));await screen.findByText('ERASED_PAGED_TITLE');
 view.rerender(<NextIntlClientProvider locale="en" messages={en}><SavedChatList {...props} nextCursor={null} initialChats={[]}/></NextIntlClientProvider>);
 await waitFor(()=>expect(screen.queryByText('ERASED_FIRST_TITLE')).toBeNull());expect(screen.queryByText('ERASED_PAGED_TITLE')).toBeNull();
});

it('drops an erased older page even when the refreshed first page and cursor are identical',async()=>{
 ports.more.mockResolvedValueOnce({ok:true,chats:[{threadId:'older',exchangeId:'older-tail',title:'ERASED_OLDER_ONLY'}],nextCursor:null,scopeDigest:'scope'});
 const initialChats=[{threadId:'first',exchangeId:'first-tail',title:'Retained first chat'}];
 const view=render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={initialChats} nextCursor="same-cursor" scopeDigest="scope" newChatHref="/assistant?chatReset=render-1"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:copy.moreChats}));await screen.findByText('ERASED_OLDER_ONLY');
 view.rerender(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={initialChats} nextCursor="same-cursor" scopeDigest="scope" newChatHref="/assistant?chatReset=render-2"/></NextIntlClientProvider>);
 await waitFor(()=>expect(screen.queryByText('ERASED_OLDER_ONLY')).toBeNull());expect(screen.getByText('Retained first chat')).toBeVisible();
});
