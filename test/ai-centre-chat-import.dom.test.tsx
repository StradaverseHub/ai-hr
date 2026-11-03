/** @vitest-environment jsdom */
/** AI v2 Phase 1, slice 3 (issue 16b) — imports inside the chat, as the HR administrator sees them (approved mock-up
 * Ask.dc.html: "help me import data" → "Which data?" → the file is attached → "211 rows ready, 3 need attention" with
 * "Confirm 211 rows" and "Fix the 3 rows").
 *
 * The composer's paperclip reads the file in the browser and sends its text with the question (never alone); the
 * question shows the file's chip. The prepared card is rendered by the real ConversationReply from a signed proposal:
 * the kind, the company, the counts, the first rows by number, column and reason, and its two buttons. Confirm posts the
 * very card with `confirm: true` and the attached file to its server action; nothing posts without a press. Fix opens the
 * import page with the file handed over in this tab. A payroll history card with an invalid row has no Confirm. A
 * caller who may not import here gets no paperclip. The server actions are spies; fictional values only; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { withAiCentre } from './helpers/ai-centre-messages';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const posts = vi.hoisted(() => ({ confirm: vi.fn(), ask: vi.fn(), earlier: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: nav.push }) }));
vi.mock('../app/assistant/chat-import-actions', () => ({ confirmChatImportAction: posts.confirm }));
vi.mock('../app/assistant/launcher-actions', () => ({ askFromWorkspaceAction: posts.ask, loadEarlierChatAction: posts.earlier }));
const messages = withAiCentre('en', en as Record<string, unknown>);
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: messages as never, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
}));
import { issueProposal } from '../core/proposals/proposal';
import { ConversationReply } from '../components/ai-centre/conversation-reply';
import { TurnImportFile, type AttachedImport } from '../components/ai-centre/chat-import-attach';
import { AssistantImportHandoffProvider, useAssistantImportHandoff } from '../components/assistant/import-handoff';
import { WorkspaceConversation } from '../components/assistant/workspace-conversation';
import type { ProposalImport } from '../core/proposals/proposal';

const copy = (messages as any).chatImport as Record<string, any>;
const tenantId = randomUUID(), userId = randomUUID(), personId = randomUUID(), companyId = randomUUID();
const TEXT = 'employee_id,leave_type,transaction_type,days,effective_date\nE0142,ANNUAL,adjustment,31,2026-01-15\n';
const HASH = 'c'.repeat(64);
const file: AttachedImport = { name: 'leave-balances-nov.xlsx', format: 'xlsx', text: TEXT, size: 2048, rows: 214 };

function card(summary: Partial<ProposalImport> = {}, route = '/admin/leave-config/import') {
  const created = new Date(), kind = summary.kind ?? 'leave_balances';
  return issueProposal({ what: { action: 'imports.chat', contractVersion: 1, entity: 'chat_import', effect: 'create', selectors: { importKind: kind, companyId, sourceHash: HASH }, reviewedDigest: 'b'.repeat(64) },
    forWhom: { tenantId, subject: 'company', subjectId: companyId }, authority: { kind: 'person', tenantId, userId, personId },
    checks: [{ check: 'rows_checked', owner: 'core/leave-import.ts#validateLeaveImport', ruleVersion: null, result: 'needs_review' }],
    review: { route, href: route, reference: randomUUID() },
    import: { kind, company: 'Acme Fictional Sdn Bhd', total: 214, ready: 211, attention: 3, warned: 0, issueCount: 3, confirmable: true, revertible: false, replacing: 0, template: null,
      issues: [{ row: 17, field: 'days', reason: 'invalid_number' }, { row: 88, field: 'leave_type', reason: 'unknown_type' }, { row: 190, field: 'employee_id', reason: 'unknown_employee' }], ...summary },
    createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 1_800_000).toISOString() });
}
const turn = (proposals: ReturnType<typeof card>[]) => ({ turnId: randomUUID(), reply: '', mode: 'propose', slot: null, suggestion: null, proposals, reads: [],
  sensitive: false, refused: false, crisis: false, fallback: false, caseRoute: null, continuation: '', trace: null as never, modelTurn: [] });
let carrier: ReturnType<typeof useAssistantImportHandoff> = null;
function Carrier() { carrier = useAssistantImportHandoff(); return null; }
async function show(proposal: ReturnType<typeof card>, attached: AttachedImport | undefined = file) {
  const element = await ConversationReply({ turn: turn([proposal]) as never });
  // The file the person sent with this turn's question, as the conversation provides it.
  render(<NextIntlClientProvider locale="en" messages={messages as never} timeZone="Asia/Kuala_Lumpur"><AssistantImportHandoffProvider>
    <Carrier /><TurnImportFile.Provider value={attached ?? null}>{element}</TurnImportFile.Provider></AssistantImportHandoffProvider></NextIntlClientProvider>);
  return screen.getByRole('article');
}
beforeEach(() => { vi.stubEnv('TERAS_PROPOSAL_SECRET', 'fictional-proposal-signing-secret-0123456789abcdef'); nav.push.mockReset(); posts.confirm.mockReset(); posts.ask.mockReset(); carrier = null; });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('the prepared import card', () => {
  it('names the kind, company and rows, counts ready and attention, and lists rows by number, column and reason', async () => {
    const article = await show(card());
    expect(within(article).getByRole('heading', { level: 3 })).toHaveTextContent('Leave balance import, Acme Fictional Sdn Bhd, 214 rows');
    expect(article).toHaveTextContent('211 rows ready');
    expect(article).toHaveTextContent('3 need attention');
    const table = within(article).getByRole('table', { name: copy.issuesLabel });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Row', 'Column', 'Issue']);
    expect(within(table).getAllByRole('row').slice(1).map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))).toEqual([
      ['17', 'days', copy.reasons.invalid_number], ['88', 'leave_type', copy.reasons.unknown_type], ['190', 'employee_id', copy.reasons.unknown_employee]]);
    expect(within(article).getByRole('button', { name: 'Confirm 211 rows' })).toBeEnabled();
    expect(within(article).getByRole('button', { name: 'Fix the 3 rows' })).toBeEnabled();
    // Leave balances have no whole-import revert, so the card does not promise one.
    expect(article).toHaveTextContent(copy.note);expect(article).not.toHaveTextContent(copy.noteRevert);
    expect(posts.confirm).not.toHaveBeenCalled();
  });

  it('Confirm posts the very card and the attached file once, then shows what the import service imported', async () => {
    const proposal = card(), article = await show(proposal);
    posts.confirm.mockResolvedValueOnce({ kind: 'imported', importKind: 'leave_balances', imported: 211, notImported: 3, historyHref: null, revertible: false, replayed: false });
    await act(async () => { fireEvent.click(within(article).getByRole('button', { name: 'Confirm 211 rows' })); });
    expect(posts.confirm).toHaveBeenCalledExactlyOnceWith({ proposal, confirm: true, file: { name: file.name, format: 'xlsx', text: TEXT } });
    const outcome = await within(article).findByRole('status');
    expect(outcome).toHaveTextContent('211 rows imported. 3 rows were not imported.');
    expect(within(article).queryByRole('button', { name: 'Confirm 211 rows' })).toBeNull();
  });

  it('a refused Confirm is said in place, and a second Confirm of the same card reads as already confirmed', async () => {
    const article = await show(card());
    posts.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'changed' });
    await act(async () => { fireEvent.click(within(article).getByRole('button', { name: 'Confirm 211 rows' })); });
    expect(await within(article).findByRole('alert')).toHaveTextContent(copy.refused.changed);
    posts.confirm.mockResolvedValueOnce({ kind: 'imported', importKind: 'leave_balances', imported: 211, notImported: 3, historyHref: null, revertible: false, replayed: true });
    await act(async () => { fireEvent.click(within(article).getByRole('button', { name: 'Confirm 211 rows' })); });
    expect(await within(article).findByRole('status')).toHaveTextContent(copy.replayed);
  });

  it('Fix opens the import page with this same file handed over in this tab only', async () => {
    const article = await show(card());
    fireEvent.click(within(article).getByRole('button', { name: 'Fix the 3 rows' }));
    expect(nav.push).toHaveBeenCalledTimes(1);
    const [href] = nav.push.mock.calls[0] as [string];
    expect(href).toMatch(/^\/admin\/leave-config\/import\?assistantImport=[0-9a-f-]{36}$/);
    expect(href).not.toContain('E0142');
    const nonce = decodeURIComponent(href.split('=')[1]);
    expect(carrier?.take('leave_balances', nonce)).toBe(TEXT);
    expect(posts.confirm).not.toHaveBeenCalled();
  });

  it('a payroll history card with an invalid row has no Confirm: every row is fixed on its page first', async () => {
    const article = await show(card({ kind: 'payroll_history', confirmable: false, revertible: true }, '/payroll/history-import'));
    expect(within(article).queryByRole('button', { name: /^Confirm/ })).toBeNull();
    expect(article).toHaveTextContent(copy.allRowsFirst);expect(article).toHaveTextContent(copy.noteRevert);
    expect(within(article).getByRole('button', { name: 'Fix the 3 rows' })).toBeEnabled();
  });
});

describe('the composer paperclip', () => {
  const composer = (chatImport: boolean) => render(<NextIntlClientProvider locale="en" messages={messages as never} timeZone="Asia/Kuala_Lumpur"><AssistantImportHandoffProvider>
    <WorkspaceConversation tasks={[]} fileImport={false} chatImport={chatImport} fullHeight /></AssistantImportHandoffProvider></NextIntlClientProvider>);
  const assistant = (messages as any).assistant;
  it('attaches one file of an accepted type, sends its text with the question, and shows its chip on the question', async () => {
    composer(true);
    const picker = screen.getByLabelText(copy.attach, { selector: 'input' }) as HTMLInputElement;
    expect(picker.accept).toBe('.xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain');
    fireEvent.change(picker, { target: { files: [new File(['%PDF'], 'payslips.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.type);
    await act(async () => { fireEvent.change(picker, { target: { files: [new File([TEXT], 'leave-balances-nov.csv', { type: 'text/csv' })] } }); });
    await screen.findByText('leave-balances-nov.csv · 1 row');
    posts.ask.mockResolvedValueOnce({ ok: true, exchangeId: 'teras-1', conversationToken: 'proof', answer: <p>Prepared fictional card</p> });
    fireEvent.change(screen.getByLabelText(assistant.workspace.question), { target: { value: '2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: assistant.ask })); });
    await screen.findByText('Prepared fictional card');
    expect(posts.ask).toHaveBeenCalledExactlyOnceWith({ question: '2', importFile: { name: 'leave-balances-nov.csv', format: 'csv', text: TEXT } });
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('2');expect(log).toHaveTextContent('leave-balances-nov.csv · 1 row');
    // The file went with that question only: the composer is clear for the next one.
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.remove.replace('{name}', 'leave-balances-nov.csv') })).toBeNull());
  });
  it('the card in that turn\'s answer posts the file sent with that question', async () => {
    composer(true);
    const picker = screen.getByLabelText(copy.attach, { selector: 'input' }) as HTMLInputElement;
    await act(async () => { fireEvent.change(picker, { target: { files: [new File([TEXT], 'leave-balances-nov.csv', { type: 'text/csv' })] } }); });
    await screen.findByText('leave-balances-nov.csv · 1 row');
    const proposal = card();
    posts.ask.mockResolvedValueOnce({ ok: true, exchangeId: 'teras-2', conversationToken: 'proof', answer: await ConversationReply({ turn: turn([proposal]) as never }) });
    fireEvent.change(screen.getByLabelText(assistant.workspace.question), { target: { value: 'leave balances' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: assistant.ask })); });
    const confirm = await screen.findByRole('button', { name: 'Confirm 211 rows' });
    posts.confirm.mockResolvedValueOnce({ kind: 'imported', importKind: 'leave_balances', imported: 211, notImported: 3, historyHref: null, revertible: false, replayed: false });
    await act(async () => { fireEvent.click(confirm); });
    expect(posts.confirm).toHaveBeenCalledExactlyOnceWith({ proposal, confirm: true, file: { name: 'leave-balances-nov.csv', format: 'csv', text: TEXT } });
  });
  it('is not there for a caller who may not import in chat', () => {
    composer(false);
    expect(screen.queryByLabelText(copy.attach)).toBeNull();
  });
});
