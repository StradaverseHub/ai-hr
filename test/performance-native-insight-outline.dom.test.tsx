import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {nativeParagraphOutline} from '../lib/ai/native-insight-outline';
const h=vi.hoisted(()=>({idp:vi.fn(),talent:vi.fn(),flush:vi.fn()}));
vi.mock('../app/performance/onehr-actions',()=>({assessmentIdpFitAction:h.idp,assessmentTalentInsightAction:h.talent}));
vi.mock('../app/performance/onehr/draft-form',()=>({flushAssessmentDrafts:h.flush}));
import {NativeInsightOutline} from '../app/performance/onehr/native-insight-outline';
import {IdpFitInsight} from '../app/performance/onehr/idp-fit-insight';
import {TalentInsight} from '../app/performance/onehr/talent-insight';
const words={title:'Suggested reading order',help:'Presentation only. These native facts and judgments are unchanged.'};
const messages={...en,onehr:{...en.onehr,protectedOutline:words}};
const wrap=(children:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>);
const paragraph='First native fact. Second native fact.';
const value=()=>({paragraph,nativeOutline:{operation:'native_outline_selection',order:[1,0],sections:nativeParagraphOutline(paragraph)}});
beforeEach(()=>{vi.clearAllMocks();h.flush.mockResolvedValue(undefined);});afterEach(cleanup);
describe('native protected insight presentation',()=>{
 it('mounts no duplicate native text while closed and lazily renders the validated order only after expansion',async()=>{
  const text='Exactly one native statement.';
  wrap(<><p>{text}</p><NativeInsightOutline data={{paragraph:text,nativeOutline:{operation:'native_outline_selection',order:[0],sections:nativeParagraphOutline(text)}}}/></>);
  expect(screen.getByText(text)).toBeTruthy();expect(screen.queryByRole('list',{name:words.title})).toBeNull();
  const summary=screen.getByText(words.title);fireEvent.click(summary);
  await waitFor(()=>expect(within(screen.getByRole('list',{name:words.title})).getByRole('listitem').textContent).toBe(text));
  expect(screen.getAllByText(text)).toHaveLength(2);fireEvent.click(summary);
  await waitFor(()=>expect(screen.queryByRole('list',{name:words.title})).toBeNull());expect(screen.getByText(text)).toBeTruthy();
 });

 it('applies the validated exhaustive model order only in the expandable presentation',async()=>{
  wrap(<><p>{paragraph}</p><NativeInsightOutline data={value()}/></>);
  expect(screen.getByText(paragraph)).toBeTruthy();const trigger=screen.getByText(words.title);expect(trigger.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(trigger);await screen.findByRole('list',{name:words.title});expect(trigger.closest('details')).toHaveAttribute('open');expect(screen.getByText(words.help)).toBeTruthy();
  expect(within(screen.getByRole('list',{name:words.title})).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['Second native fact.','First native fact.']);
 });
 it.each([
  {operation:'native_outline_selection',order:[0],sections:nativeParagraphOutline(paragraph)},
  {operation:'native_outline_selection',order:[0,0],sections:nativeParagraphOutline(paragraph)},
  {operation:'native_outline_selection',order:[0,9],sections:nativeParagraphOutline(paragraph)},
  {operation:'native_outline_selection',order:[0,1,2],sections:nativeParagraphOutline(paragraph)},
  {operation:'native_outline_selection',order:['0',1],sections:nativeParagraphOutline(paragraph)},
  {operation:'native_outline_selection',order:[1,0],sections:nativeParagraphOutline(paragraph),html:'<b>New claim</b>'},
  {operation:'native_outline_selection',order:[0],sections:[{index:0,kind:'summary',text:'Copied foreign person facts.'}]},
  {operation:'native_outline_selection',order:[0,1],sections:[{index:0,kind:'summary',text:'Forged replacement.'},{index:1,kind:'summary',text:'Second native fact.'}]},
  {operation:'native_outline_selection',order:[0,1],sections:[{index:0,kind:'summary',text:'First native fact.',rating:'OU'},{index:1,kind:'summary',text:'Second native fact.'}]},
  {operation:'write_rating',order:[0,1],sections:nativeParagraphOutline(paragraph)},
 ])('refuses incomplete/duplicate/forged/copied metadata without hiding native fallback: %#',metadata=>{
  wrap(<><p>{paragraph}</p><NativeInsightOutline data={{paragraph,nativeOutline:metadata}}/></>);
  expect(screen.getByText(paragraph)).toBeTruthy();expect(screen.queryByText(words.title)).toBeNull();expect(screen.queryByText('Copied foreign person facts.')).toBeNull();
 });
 it('keeps missing metadata and accessor payloads out of the outline',()=>{
  let accessed=false;const metadata={operation:'native_outline_selection',order:[0,1],get sections(){accessed=true;return nativeParagraphOutline(paragraph);}};
  wrap(<><NativeInsightOutline data={{paragraph}}/><NativeInsightOutline data={{paragraph,nativeOutline:metadata}}/></>);
  expect(accessed).toBe(false);expect(screen.queryByText(words.title)).toBeNull();
 });
 it('escapes source text and never creates HTML, links or executable model prose',async()=>{
  const text='<img src=x onerror=alert(1)> [source](https://example.test)';
  wrap(<NativeInsightOutline data={{paragraph:text,nativeOutline:{operation:'native_outline_selection',order:[0],sections:nativeParagraphOutline(text)}}}/>);
  fireEvent.click(screen.getByText(words.title));await screen.findByRole('listitem');expect(screen.getByRole('listitem').textContent).toBe(text);expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByRole('link')).toBeNull();
 });
 it('preserves native IDP verdict, score and primary explanation while displaying a different reading order',async()=>{
  const data={v:2 as const,kind:'idp_fit' as const,verdict:'partly_fits' as const,verdict_why:'Native direction needs discussion.',scores:'Recorded score: 19',paragraph:'Native plan has one goal.',discuss:['Discuss the recorded plan.'],nativeOutline:{operation:'native_outline_selection',order:[2,0,1],sections:[{index:0,kind:'summary',text:'Native plan has one goal.'},{index:1,kind:'decision',text:'Native direction needs discussion.'},{index:2,kind:'discussion',text:'Discuss the recorded plan.'}]}};
  h.idp.mockResolvedValue({status:'shared',canGenerate:true,pending:false,source:'ai',data});wrap(<IdpFitInsight reviewId="review"/>);
  fireEvent.click(screen.getByText(en.onehr.idpFit.title));await screen.findByText('Recorded score: 19');
  expect(screen.getByText(en.onehr.idpFit.verdict.partly_fits)).toBeTruthy();expect(screen.getByText('Native plan has one goal.')).toBeTruthy();
  fireEvent.click(screen.getByText(words.title));await screen.findByRole('list',{name:words.title});expect(within(screen.getByRole('list',{name:words.title})).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['Discuss the recorded plan.','Native plan has one goal.','Native direction needs discussion.']);
  expect(screen.getByText('Recorded score: 19')).toBeTruthy();expect(screen.getByText(en.onehr.idpFit.verdict.partly_fits)).toBeTruthy();await waitFor(()=>expect(h.idp).toHaveBeenCalledOnce());
 });
 it('preserves the native Talent decision and rejects outline text copied from another result',async()=>{
  const data={insight:'Current native insight.',decision:'Human review remains required.',nativeOutline:{operation:'native_outline_selection',order:[1,0],sections:[{index:0,kind:'summary',text:'Foreign private insight.'},{index:1,kind:'decision',text:'Human review remains required.'}]}};
  h.talent.mockResolvedValue({pending:false,source:'ai',data});wrap(<TalentInsight reviewId="review" sessionId="session"/>);
  await screen.findByText('Current native insight.');expect(screen.getByText('Human review remains required.')).toBeTruthy();expect(screen.queryByText(words.title)).toBeNull();expect(screen.queryByText('Foreign private insight.')).toBeNull();expect(h.talent).toHaveBeenCalledOnce();
 });
});
