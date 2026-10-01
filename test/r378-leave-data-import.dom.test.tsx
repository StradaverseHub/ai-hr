import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { LeaveBfRunRow } from '../lib/leave-bf-import-schema';
import { LeaveDataImport } from '../app/admin/leave-config/data-import/leave-data-import';

const actions = vi.hoisted(() => ({ validate: vi.fn(), commit: vi.fn(), bfValidate: vi.fn(), reverse: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../app/admin/leave-config/history-import/actions', () => ({ validateLeaveHistoryImportAction: actions.validate, commitLeaveHistoryImportAction: actions.commit }));
vi.mock('../app/admin/leave-config/bf-import/actions', () => ({ validateLeaveBfImportAction: actions.bfValidate, commitLeaveBfImportAction: vi.fn(), reverseLeaveBfImportAction: actions.reverse }));

function show(bfRuns: LeaveBfRunRow[] = []) { render(<NextIntlClientProvider locale="en" messages={messages}><LeaveDataImport initialType={null} historyRuns={[]} bfRuns={bfRuns} /></NextIntlClientProvider>); }
beforeEach(() => vi.clearAllMocks());
describe('Leave Data Import with real typed workbenches', () => {
  it.each(['success','refusal'] as const)('freezes type and run details during a B/F rollback, then releases after %s', async outcome => {
    const user=userEvent.setup();
    show([{id:'synthetic-run',actorName:'Synthetic HR',fileName:'synthetic.csv',mode:'replace',totalRows:1,importedRows:1,failedRows:0,ledgerRows:1,errors:[],errorsTruncated:false,reversedAt:null,createdAt:new Date().toISOString()}]);
    let finish!:()=>void;
    actions.reverse.mockImplementation(()=>new Promise<void>((resolve,reject)=>{finish=()=>outcome==='success'?resolve():reject(new Error('Synthetic rollback refusal'));}));
    await user.click(screen.getByRole('button',{name:'Details'}));
    await user.click(screen.getByRole('button',{name:'Roll back'}));
    await user.click(screen.getByRole('button',{name:'Click again to roll back'}));
    for(const choice of screen.getAllByRole('radio')) expect(choice).toBeDisabled();
    expect(screen.getByRole('button',{name:'Details'})).toBeDisabled();
    await act(async()=>finish());
    await waitFor(()=>{for(const choice of screen.getAllByRole('radio'))expect(choice).toBeEnabled();});
    expect(screen.getByRole('button',{name:'Details'})).toBeEnabled();
    expect(actions.reverse).toHaveBeenCalledExactlyOnceWith('synthetic-run');
    if(outcome==='refusal')expect(screen.getByText('Synthetic rollback refusal')).toBeVisible();
  });

  it('starts without a workflow and clears an unfinished file when switching away and back', async () => {
    const user = userEvent.setup(); show();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Template' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Leave History Data Import' }));
    await user.type(screen.getByRole('textbox'), 'unfinished history');
    await user.click(screen.getByRole('radio', { name: 'Leave B/F Data Import' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    await user.click(screen.getByRole('radio', { name: 'Leave History Data Import' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(actions.validate).not.toHaveBeenCalled();
    expect(actions.commit).not.toHaveBeenCalled();
  });
  it('rejects a B/F file locally in the history workflow without calling its server action', async () => {
    const user = userEvent.setup(); show();
    await user.click(screen.getByRole('radio', { name: 'Leave History Data Import' }));
    await user.type(screen.getByRole('textbox'), 'Employee No.,Leave Code,Entitlement Year,B/F Days\nA100,AL,2026,4');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    expect(screen.getByText(messages.admin.leaveDataImport.wrongType)).toBeVisible();
    expect(actions.validate).not.toHaveBeenCalled();
    expect(actions.commit).not.toHaveBeenCalled();
  });
  it('freezes the selected type during a commit, then releases it after a refused write', async () => {
    const user = userEvent.setup(); show();
    actions.validate.mockResolvedValue({ total: 1, validCount: 1, errorCount: 0, duplicateCount: 0, rows: [], missingColumns: [], deducts: false, balanceImpact: [] });
    let refuse!: (reason: Error) => void;
    actions.commit.mockImplementation(() => new Promise((_, reject) => { refuse = reject; }));
    await user.click(screen.getByRole('radio', { name: 'Leave History Data Import' }));
    await user.type(screen.getByRole('textbox'), 'Employee No.,Leave Reference,Leave Code,Leave Start Date,Leave End Date,Number of Day\nA100,R1,AL,2026-01-01,2026-01-01,1');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    await user.click(await screen.findByRole('button', { name: /Confirm Import/i }));
    const bfChoice = screen.getByRole('radio', { name: 'Leave B/F Data Import' });
    expect(bfChoice).toBeDisabled();
    await user.click(bfChoice);
    expect(screen.getByRole('radio', { name: 'Leave History Data Import' })).toBeChecked();
    await act(async () => { refuse(new Error('Synthetic refused write')); });
    await waitFor(() => expect(bfChoice).toBeEnabled());
    expect(screen.getByText('Synthetic refused write')).toBeVisible();
    expect(actions.commit).toHaveBeenCalledTimes(1);
  });
});
