/** Actual dialog semantics and rejected-action recovery; database authority is covered by kernel tests. */
import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';

const {save,sample}=vi.hoisted(()=>({
  save:vi.fn(async(_form:FormData):Promise<{error:string}|null>=>null),
  sample:vi.fn(async()=>{}),
}));
vi.mock('../app/(app)/reports/payroll-comparison/actions',()=>({savePayrollComparisonAction:save,createPayrollComparisonSampleAction:sample}));
vi.mock('next/link',()=>({default:({href,children,...props}:React.ComponentProps<'a'>)=><a href={href} {...props}>{children}</a>}));
import {PayrollNewReportDialog} from '../app/(app)/reports/payroll-comparison/PayrollComparisonEditor';

const labels=messages.payrollComparison;
function mount(){
  render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
    <PayrollNewReportDialog payItems={[{code:'BASIC',name:'Recorded Basic'}]}/>
  </NextIntlClientProvider>);
  return userEvent.setup();
}
function editor(){return within(screen.getByRole('button',{name:labels.saveRun}).closest('form')!);}
beforeEach(()=>{save.mockReset();save.mockResolvedValue(null);sample.mockReset();});
afterEach(cleanup);

describe('Payroll comparison creation',()=>{
  it('inner Cancel closes without saving, restores trigger focus, and discards the draft on reopen',async()=>{
    const user=mount(),trigger=screen.getByRole('button',{name:labels.newReport});
    await user.click(trigger);
    await user.clear(editor().getByRole('textbox',{name:labels.reportName}));
    await user.type(editor().getByRole('textbox',{name:labels.reportName}),'Unsaved fictional draft');
    await user.click(editor().getByRole('button',{name:labels.cancel}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();expect(save).not.toHaveBeenCalled();
    await user.click(trigger);
    expect(editor().getByRole('textbox',{name:labels.reportName})).toHaveValue('Payroll Basic Variance');
  });
  it('Escape closes either report type and reopening restores the comparison entry point',async()=>{
    const user=mount();await user.click(screen.getByRole('button',{name:labels.newReport}));
    await user.click(screen.getByRole('radio',{name:labels.listReport}));
    expect(screen.getByRole('link',{name:labels.openListBuilder})).toHaveAttribute('href','/reports/builder/new?dataset=payroll_history');
    await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:labels.newReport}));
    expect(screen.getByRole('radio',{name:labels.periodComparison})).toBeChecked();
    expect(editor().getByRole('textbox',{name:labels.reportName})).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps the name, description, amounts and unchecked access choices after a refused save, then resubmits the corrected draft',async()=>{
    save.mockResolvedValueOnce({error:labels.rolesRequired});
    const user=mount();await user.click(screen.getByRole('button',{name:labels.newReport}));
    const name=editor().getByRole('textbox',{name:labels.reportName});
    await user.clear(name);await user.type(name,'Fictional recoverable report');
    await user.type(editor().getByRole('textbox',{name:labels.description}),'Keep this description.');
    const minimum=editor().getByRole('spinbutton',{name:labels.minimum});
    await user.clear(minimum);await user.type(minimum,'5.25');
    await user.click(editor().getByRole('checkbox',{name:labels.roles.hr_admin}));
    await user.click(editor().getByRole('checkbox',{name:labels.roles.super_admin}));
    expect(editor().getByRole('checkbox',{name:labels.roles.hr_admin})).not.toBeChecked();
    expect(editor().getByRole('checkbox',{name:labels.roles.super_admin})).not.toBeChecked();
    await user.click(editor().getByRole('button',{name:labels.saveRun}));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(labels.rolesRequired));
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(save.mock.calls[0][0].getAll('roles')).toEqual([]);
    expect(name).toHaveValue('Fictional recoverable report');
    expect(editor().getByRole('textbox',{name:labels.description})).toHaveValue('Keep this description.');
    expect(minimum).toHaveValue(5.25);
    expect(editor().getByRole('checkbox',{name:labels.roles.hr_admin})).not.toBeChecked();
    expect(editor().getByRole('checkbox',{name:labels.roles.super_admin})).not.toBeChecked();
    await user.click(editor().getByRole('checkbox',{name:labels.roles.hr_admin}));
    await user.click(editor().getByRole('button',{name:labels.saveRun}));
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0].get('name')).toBe('Fictional recoverable report');
    expect(save.mock.calls[1][0].get('description')).toBe('Keep this description.');
    expect(save.mock.calls[1][0].get('minVariance')).toBe('5.25');
    expect(save.mock.calls[1][0].getAll('roles')).toEqual(['hr_admin']);
  });
  it('keeps the draft after a transport failure and gives a safe retry message',async()=>{
    save.mockRejectedValueOnce(new Error('Fictional private transport detail'));
    const user=mount();await user.click(screen.getByRole('button',{name:labels.newReport}));
    const name=editor().getByRole('textbox',{name:labels.reportName});
    await user.clear(name);await user.type(name,'Fictional network retry draft');
    await user.click(editor().getByRole('button',{name:labels.saveRun}));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(labels.saveFailed));
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(name).toHaveValue('Fictional network retry draft');
    expect(screen.queryByText('Fictional private transport detail')).not.toBeInTheDocument();
  });
});
