/** Noveri replies render a safe Markdown subset (staging acceptance, 3 November 2026: the payroll answer showed literal
 * **asterisks** because the reply text was printed as-is). Fictional; no session. */
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {ReplyMarkdown,isInAppPath,type ReplyLinks} from '../components/ai-centre/reply-markdown';

vi.mock('next/link',()=>({default:({children,href,...props}:{children:ReactNode;href:string})=><a data-next-link href={href} {...props}>{children}</a>}));
afterEach(cleanup);

// The owner's screenshot, restructured as the model now writes it (names and figures fictional).
const PAYROLL=`Payroll for November 2026 is **not ready**.

- **Blocking:** 8 employee records flagged (5 missing compensation, 5 missing statutory details) → [Personnel Management](/admin/personnel)
- **Warning:** the payroll schedule has no pay day set → [Payroll settings](/admin/payroll/settings)

Next:
1. Fix the flagged records.
2. Set the pay day.
3. Recheck readiness.`;

// This caller's destinations as the action builds them: registry titles where the registry has one, null otherwise.
const LINKS:ReplyLinks=new Map<string,string|null>([['/admin/personnel','Personnel'],['/admin/payroll/settings','Payroll settings'],['/payroll/setup','Payroll setup'],
 ['/control-tower/readiness','Readiness'],['/leave',null]]);
// The owner's second example (staging acceptance, 3 November 2026), as the model wrote it.
const STEPS=`Here is the order to process payroll:

1. **Clear the payroll blocker:** fix the flagged records in [Personnel Management](/admin/personnel).
2. **Set the schedule:** add the pay day in [Payroll Settings](/payroll/setup).
3. **Check readiness:** review [Employee data](/control-tower/readiness).
4. **Enter transactions:** add this month's items in [Transaction Entry](/payroll/transactions).`;

describe('Noveri reply rendering',()=>{
 it('renders the payroll answer as a list with bold and in-app links, never literal asterisks',()=>{
  const view=render(<ReplyMarkdown text={PAYROLL} links={LINKS}/>);
  const root=view.container.querySelector('[data-teras-text]')!;
  expect(root.textContent).not.toContain('**');
  expect(root.querySelectorAll('ul > li')).toHaveLength(2);
  expect(root.querySelectorAll('ol > li')).toHaveLength(3);
  expect([...root.querySelectorAll('strong')].map(el=>el.textContent)).toEqual(['not ready','Blocking:','Warning:']);
  expect([...root.querySelectorAll('a[data-next-link]')].map(el=>[el.textContent,el.getAttribute('href')]))
   .toEqual([['Personnel','/admin/personnel'],['Payroll settings','/admin/payroll/settings']]);
 });
 it('keeps raw HTML and script as escaped text',()=>{
  const view=render(<ReplyMarkdown links={LINKS} text={'Hello <script>alert(1)</script> and <b onclick="x()">bold</b> <img src=x onerror=alert(1)>'}/>);
  expect(view.container.querySelector('script, b, img, [onclick], [onerror]')).toBeNull();
  expect(view.container.textContent).toContain('<script>alert(1)</script>');
 });
 it('never renders a link that is not an in-app path, nor an image',()=>{
  const view=render(<ReplyMarkdown links={LINKS} text={'[a](https://evil.example) [b](//evil.example/x) [c](javascript:alert(1)) [d](/\\evil) ![e](/logo.png) [ok](/leave)'}/>);
  expect([...view.container.querySelectorAll('a')].map(el=>el.getAttribute('href'))).toEqual(['/leave']);
  expect(view.container.querySelector('img')).toBeNull();
  for(const label of ['a','b','c','d'])expect(view.container.textContent).toContain(label);
 });
 it('does not render headings, tables or code as such, keeping their text',()=>{
  const view=render(<ReplyMarkdown links={LINKS} text={'# Big\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n`code`'}/>);
  expect(view.container.querySelector('h1, table, code, pre')).toBeNull();
  expect(view.container.textContent).toContain('Big');expect(view.container.textContent).toContain('code');
 });
 it('renders numbered steps with registry titles, an off-list page as text, and no raw markup at all',()=>{
  const view=render(<ReplyMarkdown text={STEPS} links={LINKS}/>);
  const root=view.container.querySelector('[data-teras-text]')!;
  for(const raw of ['**','[','](']) expect(root.textContent).not.toContain(raw);
  expect(root.querySelectorAll('ol > li')).toHaveLength(4);
  // The registry names the page, not the model: "Employee data" was a misleading label for the readiness page.
  expect([...root.querySelectorAll('a[data-next-link]')].map(el=>[el.textContent,el.getAttribute('href')]))
   .toEqual([['Personnel','/admin/personnel'],['Payroll setup','/payroll/setup'],['Readiness','/control-tower/readiness']]);
  // /payroll/transactions is not one of this caller's destinations: its label stays, as plain text.
  expect(root.textContent).toContain('Transaction Entry');
  expect(root.querySelector('a[href="/payroll/transactions"]')).toBeNull();
 });
 it('keeps the model label for a linkable page the registry does not title, and links nothing without an allow-list',()=>{
  const titled=render(<ReplyMarkdown text={'Open [your leave](/leave).'} links={LINKS}/>);
  expect(titled.container.querySelector('a[href="/leave"]')?.textContent).toBe('your leave');
  cleanup();
  const bare=render(<ReplyMarkdown text={'Open [your leave](/leave).'} links={new Map()}/>);
  expect(bare.container.querySelector('a')).toBeNull();expect(bare.container.textContent).toBe('Open your leave.');
 });
 it('accepts only same-app paths',()=>{
  for(const ok of ['/leave','/admin/personnel?tab=records#x','/assistant?view=inbox'])expect(isInAppPath(ok),ok).toBe(true);
  for(const bad of [undefined,'','leave','//evil.example','/\\evil','https://evil.example','javascript:alert(1)','/a b'])expect(isInAppPath(bad),String(bad)).toBe(false);
 });
});
