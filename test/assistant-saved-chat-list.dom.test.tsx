/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({more:vi.fn()}));
vi.mock('../app/assistant/launcher-actions',()=>({loadMoreChatsAction:ports.more}));
vi.mock('next/link',()=>({default:({children,scroll,...props}:any)=><a {...props}>{children}</a>}));
import {beginChatListUpdate,publishChatListUpdate} from '../components/assistant/chat-list-updates';
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

const scoped='a'.repeat(64),threadId='71000000-0000-4000-8000-000000000001',tailId='71000000-0000-4000-8000-000000000002';
it('updates the newest tail once in place and discards superseded or foreign-scope snapshots',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={[]} nextCursor={null} scopeDigest={scoped} newChatHref="/assistant?chatReset=live"/></NextIntlClientProvider>);
 const oldTicket=beginChatListUpdate(),newTicket=beginChatListUpdate(),page={chats:[{threadId,exchangeId:tailId,title:'New current tail'},{threadId,exchangeId:threadId,title:'Duplicate older tail'}],nextCursor:null,scopeDigest:scoped};
 act(()=>publishChatListUpdate(newTicket,page));expect(screen.getByRole('link',{name:'New current tail'})).toHaveAttribute('href','/assistant?e='+tailId);expect(screen.queryByText('Duplicate older tail')).toBeNull();
 act(()=>publishChatListUpdate(oldTicket,{...page,chats:[{threadId,exchangeId:threadId,title:'STALE_RESPONSE'}]}));expect(screen.queryByText('STALE_RESPONSE')).toBeNull();
 act(()=>publishChatListUpdate(beginChatListUpdate(),{...page,scopeDigest:'b'.repeat(64),chats:[{threadId,exchangeId:threadId,title:'FOREIGN_SCOPE'}]}));expect(screen.queryByText('FOREIGN_SCOPE')).toBeNull();
});
it('lets an authoritative erasure reset win over a response begun before it',()=>{
 const props={initialChats:[],nextCursor:null,scopeDigest:scoped};
 const view=render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList {...props} newChatHref="/assistant?chatReset=before"/></NextIntlClientProvider>);
 const delayedTicket=beginChatListUpdate();view.rerender(<NextIntlClientProvider locale="en" messages={en}><SavedChatList {...props} newChatHref="/assistant?chatReset=after-erasure"/></NextIntlClientProvider>);
 act(()=>publishChatListUpdate(delayedTicket,{chats:[{threadId,exchangeId:tailId,title:'ERASED_DELAYED_TITLE'}],nextCursor:null,scopeDigest:scoped}));expect(screen.queryByText('ERASED_DELAYED_TITLE')).toBeNull();
});
it('refuses malformed presentation packets rather than rendering arbitrary record-shaped links',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><SavedChatList initialChats={[]} nextCursor={null} scopeDigest={scoped} newChatHref="/assistant?chatReset=validation"/></NextIntlClientProvider>);
 for(const bad of [{chats:[{threadId,exchangeId:'https://foreign.example',title:'BAD_LINK'}],nextCursor:null,scopeDigest:scoped},{chats:Array.from({length:21},()=>({threadId,exchangeId:tailId,title:'OVERSIZED'})),nextCursor:null,scopeDigest:scoped}])act(()=>publishChatListUpdate(beginChatListUpdate(),bad));
 expect(screen.queryByText('BAD_LINK')).toBeNull();expect(screen.queryByText('OVERSIZED')).toBeNull();
});
