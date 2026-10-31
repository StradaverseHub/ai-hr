/** @vitest-environment jsdom */
/** Source-authored interaction cases, UNRUN. These are not actual browser/locale/a11y proof. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceComposer } from '../components/assistant/workspace-composer';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
const status = vi.hoisted(() => ({ pending: false }));
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), useFormStatus: () => status }));
afterEach(() => { cleanup(); status.pending = false; });
type Copy = { assistant: Pick<typeof en.assistant, 'ask' | 'placeholder' | 'scopeNote' | 'workspace'> };
function props(messages: Copy = en) {
  const copy = messages.assistant, w = copy.workspace;
  return { action: vi.fn(async () => {}), tasks: [{ id: 'claim_statuses' as const, label: w.claim_statuses_label, prompt: w.claim_statuses_prompt },
    { id: 'holidays' as const, label: w.holidays_label, prompt: w.holidays_prompt.replace('{date}', '2026-10-26') }],
    labels: { tasks: w.tasks, taskHint: w.taskHint, question: w.question, placeholder: copy.placeholder,
      ask: copy.ask, working: w.working, scope: copy.scopeNote } };
}
describe('workspace question composer', () => {
  it('fills and focuses an editable question without submitting, retrieving or calling a provider', () => {
    const p = props(), view = render(<WorkspaceComposer {...p} />);
    const question = screen.getByLabelText(p.labels.question) as HTMLTextAreaElement;
    expect((screen.getByRole('button', { name: p.labels.ask }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: p.tasks[0].label }));
    expect(question.value).toBe(p.tasks[0].prompt); expect(document.activeElement).toBe(question);
    expect(p.action).not.toHaveBeenCalled();
    fireEvent.change(question, { target: { value: 'My edited question' } });
    expect(question.value).toBe('My edited question');
    const data = new FormData(view.container.querySelector('form')!);
    expect([...data.keys()]).toEqual(['question']); expect(data.get('question')).toBe('My edited question');
    expect(question.maxLength).toBe(2000);
    expect((screen.getByRole('button', { name: p.labels.ask }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('disables duplicate submits and task replacement while the current action is pending', () => {
    const p = props(), view = render(<WorkspaceComposer {...p} />);
    fireEvent.click(screen.getByRole('button', { name: p.tasks[0].label }));
    status.pending = true; view.rerender(<WorkspaceComposer {...p} />);
    const submit = screen.getByRole('button', { name: p.labels.working }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); expect(submit.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByLabelText(p.labels.question) as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByRole('button', { name: p.tasks[1].label }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe(p.labels.working);
    status.pending = false; view.rerender(<WorkspaceComposer {...p} />);
    expect((screen.getByLabelText(p.labels.question) as HTMLTextAreaElement).value).toBe(p.tasks[0].prompt);
    expect(p.action).not.toHaveBeenCalled();
  });
  it('leaves the pending live announcement to an external chat host',()=>{
    const p=props();status.pending=true;render(<WorkspaceComposer {...p} pending/>);
    expect(screen.getByRole('button',{name:p.labels.working})).toBeDisabled();expect(screen.queryByRole('status')).toBeNull();
  });
  it.each(Object.entries({ en, ms, zh, ta, vi: viMessages, th }))('%s has labeled task and question controls with a resolved calendar date', (_locale, messages) => {
    const p = props(messages); render(<WorkspaceComposer {...p} />);
    expect(screen.getByRole('region', { name: p.labels.tasks })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: p.tasks[1].label }));
    const question = screen.getByLabelText(p.labels.question) as HTMLTextAreaElement;
    expect(question.value).toContain('2026-10-26'); expect(question.value).not.toContain('{date}');
    expect(question.value.length).toBeLessThan(2000);
    expect(p.action).not.toHaveBeenCalled();
  });
});
