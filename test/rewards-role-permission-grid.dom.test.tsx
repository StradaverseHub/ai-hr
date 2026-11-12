// @vitest-environment jsdom
/** Board db14e49c: the Role permissions grid - dropdown cells with only their allowed options, highlighted edits with
 * the old value, locked cells with reasons, the pinned save bar, the review summary, discard, the changed-only filter,
 * the legend, the leave warning, versions (compare and restore) and the read-only state. Fictional data only. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const ports=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),decide:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/admin/rewards/access/policy-actions',()=>({previewRewardRolePermissionBatchAction:ports.preview,saveRewardRolePermissionBatchAction:ports.save,decideRewardRolePermissionRequestAction:ports.decide}));
import {RewardRolePermissions,type RolePermissionGridView} from '../app/admin/rewards/access/role-permissions';

const copies={en,ms,zh,ta,th,vi:viCopy};
const grid=(over:Partial<RolePermissionGridView>={}):RolePermissionGridView=>({matrix:{'bu:review.decide':'none'},revision:3,heldRoles:['gr'],immediate:true,proposer:false,viewingAs:false,
 versions:[{revision:3,action:'saved',savedAt:'2026-11-10 09:30:00+08',savedBy:'Fictional Rewards lead',reason:'Narrowed the CTRO bonus page',changes:[{role:'ctro',capability:'bonus.view',before:'view',after:'none'}],matrix:{'ctro:bonus.view':'none'},restoredFrom:null}],
 requests:[],...over});
const show=(value=grid(),locale:keyof typeof copies='en')=>render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><RewardRolePermissions grid={value} holders={[{role:'gr',name:'Fictional Rewards lead',proxy:false}]}/></NextIntlClientProvider>);
const cell=(name:RegExp)=>screen.getByRole('combobox',{name}) as HTMLSelectElement;
beforeEach(()=>{ports.preview.mockResolvedValue({ok:true,mode:'apply',digest:'a'.repeat(64),summary:{area:'role_permission',itemLabel:'Role permissions',lines:[{key:'proxy_bg:offcycle.decide',label:'Proxy BG CEO · Approve off-cycle request',before:'At their step',after:'—'}],changedCount:1,affected:[],highImpact:['remove-access']}});
 ports.save.mockResolvedValue({ok:true,mode:'applied'});HTMLDialogElement.prototype.showModal??=function(this:HTMLDialogElement){this.setAttribute('open','');};HTMLDialogElement.prototype.close??=function(this:HTMLDialogElement){this.removeAttribute('open');};});
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('Role permissions grid',()=>{
 it('shows the legend, the corrected rows, scope types and only the options each cell allows',()=>{
  show();
  const legend=screen.getByRole('list',{name:'Permission levels'});
  expect(within(legend).getAllByRole('listitem').map(li=>li.textContent)).toEqual(['Full see and change','At their step act only at their approval step','View only see without changing','— no access']);
  expect(screen.getByText('Reviewing Team Rewards')).toBeTruthy();expect(screen.getByText('Promotion nominations')).toBeTruthy();
  expect(screen.queryByText('Review Cycles')).toBeNull();expect(screen.getByRole('rowheader',{name:'Limit Controls'})).toBeTruthy();
  expect([...cell(/^CTRO · Limit Controls$/).options].map(o=>o.value)).toEqual(['view','none']);expect([...cell(/^Executive Chairman · Limit Controls$/).options].map(o=>o.value)).toEqual(['view','none']);
  expect(screen.getAllByText('HR Admin').length).toBeGreaterThan(0);expect(screen.getAllByText('Payroll').length).toBeGreaterThan(0);
  const scope=screen.getByText('Units in scope').closest('tr')!;
  expect([...scope.querySelectorAll('td')].map(td=>td.textContent)).toEqual(['Assigned companies','Assigned Business Units','Assigned Business Units','Whole group','Whole group','Whole group','Assigned companies (view only)','—','Assigned companies']);
  expect([...cell(/^CTRO · Salary Structures$/).options].map(o=>o.textContent)).toEqual(['View only','—']);
  expect([...cell(/^Proxy BG CEO · Approve off-cycle request$/).options].map(o=>o.textContent)).toEqual(['At their step','—']);
  expect([...cell(/^Executive Chairman · Senior plan amounts$/).options].map(o=>o.value)).toEqual(['view','none']);
 });
 it('greys locked cells with the reason, including the role the editor holds, and flags an older setting that breaks a lock',()=>{
  show();
  const gr=screen.getByLabelText(/^Group Rewards · Rewards Access: Full\. Group Rewards keeps Rewards Access so it can't lock itself out\.$/);
  expect(gr.getAttribute('title')).toBe("Group Rewards keeps Rewards Access so it can't lock itself out.");
  expect(screen.getByLabelText(/^BU CEO · See or set own reward: Never\. See or set own reward is always Never\.$/)).toBeTruthy();
  expect(screen.getByLabelText(/^Group Rewards · Reviewing Team Rewards: View only\. You hold this role/)).toBeTruthy();
  expect(screen.queryByRole('combobox',{name:/^Group Rewards · /})).toBeNull();
  // The legacy saved setting that removed BU CEO's Submit or approve.
  expect(screen.getByRole('status').textContent).toMatch(/1 older saved setting removes a fixed approval step/);
  expect(screen.getByLabelText(/^BU CEO · Submit or approve: —\. Submit or approve stays on/).textContent).toContain('An older saved setting differs');
 });
 it('highlights an edit with its old value, counts net changes, discards and filters changed rows',()=>{
  show();
  expect(screen.queryByRole('region',{name:'Unsaved changes'})).toBeNull();
  const proxy=cell(/^Proxy BG CEO · Approve off-cycle request$/);
  fireEvent.change(proxy,{target:{value:'none'}});
  expect(proxy.getAttribute('title')).toBe('Was: At their step');expect(proxy.dataset.changed).toBe('true');
  const bar=screen.getByRole('region',{name:'Unsaved changes'});expect(within(bar).getByText('1 change')).toBeTruthy();
  fireEvent.change(cell(/^CTRO · Bonus Matrices$/),{target:{value:'none'}});expect(within(bar).getByText('2 changes')).toBeTruthy();
  // Reverting a cell removes it from the count.
  fireEvent.change(cell(/^CTRO · Bonus Matrices$/),{target:{value:'view'}});expect(within(bar).getByText('1 change')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox',{name:'Changed from default only'}));
  const rows=[...document.querySelectorAll('tbody th[scope=row]')].map(th=>th.textContent);
  expect(rows).toEqual(['Submit or approve','Approve off-cycle request']);
  fireEvent.click(within(bar).getByRole('button',{name:'Discard'}));
  expect(screen.queryByRole('region',{name:'Unsaved changes'})).toBeNull();
 });
 it('needs a reason, shows the server summary in this language and saves the whole batch with the reviewed digest',async()=>{
  show();
  fireEvent.change(cell(/^Proxy BG CEO · Approve off-cycle request$/),{target:{value:'none'}});
  const bar=screen.getByRole('region',{name:'Unsaved changes'});
  fireEvent.click(within(bar).getByRole('button',{name:'Save changes'}));
  expect(screen.getByRole('alert').textContent).toBe('Give a reason of at least 10 characters.');expect(ports.preview).not.toHaveBeenCalled();
  await new Promise(resolve=>setTimeout(resolve,0));// a second click is a new event turn (ActionButton guard)
  fireEvent.change(within(bar).getByRole('textbox',{name:'Reason for change'}),{target:{value:'Proxy no longer approves off-cycle'}});
  fireEvent.click(within(bar).getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(ports.preview).toHaveBeenCalledWith({baseRevision:3,changes:[{role:'proxy_bg',capability:'offcycle.decide',after:'none'}],reason:'Proxy no longer approves off-cycle',digest:null,action:'saved',restoredFrom:null}));
  const dialog=await screen.findByRole('dialog');
  expect(within(dialog).getByRole('rowheader',{name:'Proxy BG CEO · Approve off-cycle request'}).closest('tr')!.textContent).toBe('Proxy BG CEO · Approve off-cycle requestAt their step—');
  expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Proxy no longer approves off-cycle');
  const confirm=await waitFor(()=>{const button=within(dialog).getByRole('button',{name:'Save changes'});expect(button.hasAttribute('disabled')).toBe(false);return button;});
  fireEvent.click(confirm);
  await waitFor(()=>expect(ports.save).toHaveBeenCalledWith(expect.objectContaining({baseRevision:3,digest:'a'.repeat(64),reason:'Proxy no longer approves off-cycle',changes:[{role:'proxy_bg',capability:'offcycle.decide',after:'none'}]})));
  expect(ports.refresh).toHaveBeenCalledTimes(1);expect(await screen.findByText('Role permissions saved.')).toBeTruthy();
 });
 it('shows a typed refusal (stale revision) and keeps the edits',async()=>{
  ports.preview.mockResolvedValue({ok:false,error:'stale'});show();
  fireEvent.change(cell(/^CTRO · Bonus Matrices$/),{target:{value:'none'}});
  const bar=screen.getByRole('region',{name:'Unsaved changes'});
  fireEvent.change(within(bar).getByRole('textbox'),{target:{value:'Narrow the CTRO bonus page'}});fireEvent.click(within(bar).getByRole('button',{name:'Save changes'}));
  expect((await screen.findByRole('alert')).textContent).toMatch(/permissions changed since you opened them/);
  await waitFor(()=>expect(cell(/^CTRO · Bonus Matrices$/).value).toBe('none'));expect(ports.save).not.toHaveBeenCalled();
 });
 it('warns before leaving with unsaved changes',()=>{
  show();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  const link=document.createElement('a');link.href='/admin/rewards/change-log';link.textContent='Leave';document.body.append(link);
  fireEvent.click(link);expect(confirm).not.toHaveBeenCalled();
  fireEvent.change(cell(/^CTRO · Bonus Matrices$/),{target:{value:'none'}});
  const event=new MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);
  expect(confirm).toHaveBeenCalledWith('You have unsaved permission changes. Leave this page and lose them?');expect(event.defaultPrevented).toBe(true);
  const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
  link.remove();confirm.mockRestore();
 });
 it('resets role defaults after a confirmation, except the role the editor holds',()=>{
  const value=grid({matrix:{'ctro:bonus.view':'none','gr:figures.edit':'none','bu:review.decide':'none'}});
  show(value);const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button',{name:'Reset role defaults'}));
  expect(confirm).toHaveBeenCalledWith("Load every role's defaults as unsaved changes? You can review them before saving.");
  expect(cell(/^CTRO · Bonus Matrices$/).value).toBe('view');
  expect(within(screen.getByRole('region',{name:'Unsaved changes'})).getByText('2 changes')).toBeTruthy();
  expect(screen.getByText('1 cell was left unchanged because it is locked for you.')).toBeTruthy();
  confirm.mockRestore();
 });
 it('compares a version with the current permissions and restores it as edits',async()=>{
  show(grid({matrix:{}}));
  fireEvent.click(screen.getByRole('button',{name:'Compare with current'}));
  const history=screen.getByRole('region',{name:'Version history'});
  expect(within(history).getByRole('rowheader',{name:'CTRO · Bonus Matrices'}).closest('tr')!.textContent).toBe('CTRO · Bonus Matrices—View only');
  fireEvent.click(within(history).getByRole('button',{name:'Restore'}));
  expect(cell(/^CTRO · Bonus Matrices$/).value).toBe('none');
  const bar=screen.getByRole('region',{name:'Unsaved changes'});
  fireEvent.change(within(bar).getByRole('textbox'),{target:{value:'Restore version three settings'}});fireEvent.click(within(bar).getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(ports.preview).toHaveBeenCalledWith(expect.objectContaining({action:'restored',restoredFrom:3,changes:[{role:'ctro',capability:'bonus.view',after:'none'}]})));
 });
 it('is read only for users without authority and while viewing as someone',()=>{
  show(grid({immediate:false,proposer:false}));
  expect(screen.queryAllByRole('combobox')).toHaveLength(0);expect(screen.queryByRole('button',{name:'Reset role defaults'})).toBeNull();expect(screen.queryByRole('button',{name:'Restore'})).toBeNull();
  expect(screen.getByText('You can view these permissions. Group Rewards, HR Admin or CTRO can change them.')).toBeTruthy();
  cleanup();show(grid({viewingAs:true}));expect(screen.queryAllByRole('combobox')).toHaveLength(0);expect(screen.getByText('Read-only while View as is active.')).toBeTruthy();
 });
 it('sends a proposer batch for approval and lets an independent checker decide a waiting batch',async()=>{
  ports.preview.mockResolvedValue({ok:true,mode:'request',digest:'b'.repeat(64),summary:{area:'role_permission',itemLabel:'Role permissions',lines:[],changedCount:1,affected:[],highImpact:[]}});
  ports.save.mockResolvedValue({ok:true,mode:'requested'});ports.decide.mockResolvedValue({ok:true,status:'applied'});
  show(grid({immediate:false,proposer:true,requests:[{id:'40000000-0000-4000-8000-000000000001',changes:[{role:'pbp',capability:'rules.view',before:'view',after:'none'}],reason:'PBP no longer needs rules',requestedName:'Fictional company reviewer',requestedAt:'2026-11-11 10:00:00+08',status:'pending',decidedName:null,decidedAt:null,decisionReason:null,canDecide:true}]}));
  expect(screen.getByText('Your changes go to Waiting for approval. Group Rewards, HR Admin or CTRO approves them.')).toBeTruthy();
  const waiting=screen.getByText('1 role permission change waiting for approval').closest('div')!;
  expect(within(waiting).getByText('PBP (read only) · Rules: View only → —')).toBeTruthy();
  fireEvent.click(within(waiting).getByRole('button',{name:'Approve'}));
  await waitFor(()=>expect(ports.decide).toHaveBeenCalledWith({requestId:'40000000-0000-4000-8000-000000000001',approve:true,reason:''}));
  expect(within(waiting).getByRole('button',{name:'Reject'}).hasAttribute('disabled')).toBe(true);
  fireEvent.change(await waitFor(()=>cell(/^CTRO · Bonus Matrices$/)),{target:{value:'none'}});
  const bar=screen.getByRole('region',{name:'Unsaved changes'});
  fireEvent.change(within(bar).getByRole('textbox'),{target:{value:'Ask to narrow CTRO bonus'}});fireEvent.click(within(bar).getByRole('button',{name:'Save changes'}));
  const dialog=await screen.findByRole('dialog');fireEvent.click(await within(dialog).findByRole('button',{name:'Send for approval'}));
  expect(await screen.findByText('Sent for approval.')).toBeTruthy();
 });
 it('renders in every supported locale',()=>{
  for(const locale of ['ms','zh','ta','th','vi'] as const){show(grid(),locale);expect(screen.getAllByRole('combobox').length).toBeGreaterThan(10);cleanup();}
 });
 it('captures the grid with an edit and the pinned save bar',async()=>{
  const view=show();fireEvent.change(cell(/^Proxy BG CEO · Approve off-cycle request$/),{target:{value:'none'}});
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-role-permissions','Actual role permission grid with one edit and the save bar; fictional role holder and write port.');
 },60000);
});
