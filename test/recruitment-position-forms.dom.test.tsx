/**
 * Slice 15 review — a refused save of the NEW-POSITION form or the POSITION TEMPLATE form keeps everything typed and the chosen
 * company, and names each refused field beside it (app/recruitment/action-form.tsx, app/recruitment/form-state.ts).
 *
 * The real forms are server components (their fields come from next-intl/server and the database), so each form's controls are
 * reproduced here with the SAME names and kinds as the pages render them — hidden company, text, textarea, job-level checkboxes,
 * selects, custom fields (`cf.<id>`, a multiple choice as repeated checkboxes), the interview plan's marker and repeated round
 * selects — inside the real ActionForm and FieldProblem. The server action is replaced by one that refuses the way
 * app/recruitment/actions.ts does (its `refusal` builds exactly this state from the submitted FormData with formValuesOf).
 * Expected values are the ones typed in this test, written out by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActionForm, FieldProblem } from '../app/recruitment/action-form';
import { formValuesOf, restoreFormValues, type FormRefusal } from '../app/recruitment/form-state';

afterEach(cleanup);

const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const [G1, G2, FORM1, FORM2, CF_TEXT, CF_MULTI, OPT_A, OPT_B] = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

/** A refusing action, like actions.ts `refusal`: the code, its sentence, the refused fields and what the form carried. */
function refusingAction(problem: string, fields: string[]) {
  const received: FormData[] = [];
  const action = vi.fn(async (prev: FormRefusal, form: FormData): Promise<FormRefusal> => {
    received.push(form);
    return { status: 'refused', problem, errorText: `Refused: ${problem}`, fields, values: formValuesOf(form), nonce: (prev.nonce ?? 0) + 1 };
  });
  return { action, received };
}
const problem = (name: string) => <FieldProblem name={name} required="Fill in this field." invalid="Check this value." />;

/** The new-position form's controls (app/recruitment/positions/new/page.tsx + job-fields + custom-fields-ui + interview-plan). */
function NewPositionFields() {
  return (
    <>
      <input type="hidden" name="companyId" value={COMPANY_B} />
      <input aria-label="Job title" name="title" defaultValue="" />{problem('title')}
      <textarea aria-label="Job description" name="description" defaultValue="" />
      <label><input type="checkbox" name="jobGradeIds" value={G1} />Grade 1</label>
      <label><input type="checkbox" name="jobGradeIds" value={G2} />Grade 2</label>{problem('jobLevel')}
      <input aria-label="Work location" name="workLocation" defaultValue="" />
      <select aria-label="Recruitment type" name="recruitmentType" defaultValue=""><option value="">Choose</option><option value="budgeted">Budgeted</option><option value="replacement">Replacement</option></select>
      <input type="hidden" name="cf.present" value="1" />
      <input aria-label="Shift pattern" name={`cf.${CF_TEXT}`} defaultValue="" />{problem(`cf.${CF_TEXT}`)}
      <label><input type="checkbox" name={`cf.${CF_MULTI}`} value={OPT_A} />Malay</label>
      <label><input type="checkbox" name={`cf.${CF_MULTI}`} value={OPT_B} />English</label>
      <input type="hidden" name="ip.present" value="1" />
      {[1, 2, 3, 4].map((n) => (
        <select key={n} aria-label={`Round ${n}`} name="interviewPlanFormIds" defaultValue="">
          <option value="">No round</option><option value={FORM1}>Technical</option><option value={FORM2}>Default</option>
        </select>
      ))}
      {problem('interviewPlan')}
      <label><input type="checkbox" name="autoArchiveAfterReject" />Archive after reject</label>
      <button type="submit">Create</button>
    </>
  );
}

/** The position template form's controls (app/recruitment/settings/position-template-settings.tsx). */
function TemplateFields() {
  return (
    <>
      <input type="hidden" name="companyId" value={COMPANY_B} />
      <input aria-label="Template name" name="name" defaultValue="" />{problem('name')}
      <input aria-label="Job title" name="title" defaultValue="" />
      <select aria-label="Recruitment process" name="processId" defaultValue=""><option value="">Default process</option><option value="p-fast">Fast track</option></select>
      <label><input type="checkbox" name="enabled" defaultChecked />Enabled</label>
      <input type="hidden" name="cf.present" value="1" />
      <input aria-label="Shift pattern" name={`cf.${CF_TEXT}`} defaultValue="" />
      <input type="hidden" name="ip.present" value="1" />
      {[1, 2].map((n) => (
        <select key={n} aria-label={`Round ${n}`} name="interviewPlanFormIds" defaultValue="">
          <option value="">No round</option><option value={FORM1}>Technical</option><option value={FORM2}>Default</option>
        </select>
      ))}
      {problem('interviewPlan')}
      <button type="submit">Save template</button>
    </>
  );
}

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;
const checked = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).checked;

describe('the new-position form keeps everything typed, and the company, when the save is refused', () => {
  it('values survive a refused submit; the refused fields say so beside them; the company sent is the chosen one', async () => {
    const { action, received } = refusingAction('invalid_input', ['interviewPlan', `cf.${CF_TEXT}`]);
    render(<ActionForm action={action}><NewPositionFields /></ActionForm>);
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Fictional payroll analyst' } });
    fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'Fictional description\nsecond line' } });
    fireEvent.click(screen.getByLabelText('Grade 2'));
    fireEvent.change(screen.getByLabelText('Work location'), { target: { value: 'Penang' } });
    fireEvent.change(screen.getByLabelText('Recruitment type'), { target: { value: 'replacement' } });
    fireEvent.change(screen.getByLabelText('Shift pattern'), { target: { value: 'x'.repeat(5) } });
    fireEvent.click(screen.getByLabelText('English'));
    // A gap in the plan: round 1 empty, round 2 filled.
    fireEvent.change(screen.getByLabelText('Round 2'), { target: { value: FORM1 } });
    fireEvent.click(screen.getByLabelText('Archive after reject'));
    expect(screen.queryByText('Check this value.')).toBeNull();
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(screen.getByText('Refused: invalid_input')).toBeTruthy());
    // Everything typed is still there.
    expect(value('Job title')).toBe('Fictional payroll analyst');
    expect(value('Job description')).toBe('Fictional description\nsecond line');
    expect([checked('Grade 1'), checked('Grade 2')]).toEqual([false, true]);
    expect(value('Work location')).toBe('Penang');
    expect(value('Recruitment type')).toBe('replacement');
    expect(value('Shift pattern')).toBe('xxxxx');
    expect([checked('Malay'), checked('English')]).toEqual([false, true]);
    expect([1, 2, 3, 4].map((n) => value(`Round ${n}`))).toEqual(['', FORM1, '', '']);
    expect(checked('Archive after reject')).toBe(true);
    // Each refused field says so beside it, and only those.
    const marks = Array.from(document.querySelectorAll('[data-field-problem]')).map((e) => [e.getAttribute('data-field-problem'), e.textContent]);
    expect(marks).toEqual([[`cf.${CF_TEXT}`, 'Check this value.'], ['interviewPlan', 'Check this value.']]);
    // The company is the chosen one (sent with the save, and still on the form for the next try); nothing went into a URL.
    expect(received).toHaveLength(1);
    expect(received[0].get('companyId')).toBe(COMPANY_B);
    expect((document.querySelector('input[name="companyId"]') as HTMLInputElement).value).toBe(COMPANY_B);
    expect(window.location.search).toBe('');
    // A second try sends the same company again, with the corrected plan.
    fireEvent.change(screen.getByLabelText('Round 1'), { target: { value: FORM2 } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(received).toHaveLength(2));
    expect(received[1].get('companyId')).toBe(COMPANY_B);
    expect(received[1].getAll('interviewPlanFormIds')).toEqual([FORM2, FORM1, '', '']);
  });

  it('a missing required field is named as missing', async () => {
    const { action } = refusingAction('missing_fields', ['title', 'jobLevel']);
    render(<ActionForm action={action}><NewPositionFields /></ActionForm>);
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(screen.getByText('Refused: missing_fields')).toBeTruthy());
    const marks = Array.from(document.querySelectorAll('[data-field-problem]')).map((e) => [e.getAttribute('data-field-problem'), e.textContent]);
    expect(marks).toEqual([['title', 'Fill in this field.'], ['jobLevel', 'Fill in this field.']]);
  });
});

describe('the position template form keeps everything typed when the save is refused', () => {
  it('values survive a refused submit (an unchecked "enabled" stays unchecked) and the name says why', async () => {
    const { action, received } = refusingAction('name_taken', ['name']);
    render(<ActionForm action={action}><TemplateFields /></ActionForm>);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Fictional analyst template' } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Fictional analyst' } });
    fireEvent.change(screen.getByLabelText('Recruitment process'), { target: { value: 'p-fast' } });
    fireEvent.click(screen.getByLabelText('Enabled'));
    fireEvent.change(screen.getByLabelText('Shift pattern'), { target: { value: 'Rotating' } });
    fireEvent.change(screen.getByLabelText('Round 1'), { target: { value: FORM2 } });
    fireEvent.click(screen.getByText('Save template'));
    await waitFor(() => expect(screen.getByText('Refused: name_taken')).toBeTruthy());
    expect(value('Template name')).toBe('Fictional analyst template');
    expect(value('Job title')).toBe('Fictional analyst');
    expect(value('Recruitment process')).toBe('p-fast');
    expect(checked('Enabled')).toBe(false);
    expect(value('Shift pattern')).toBe('Rotating');
    expect([value('Round 1'), value('Round 2')]).toEqual([FORM2, '']);
    expect(document.querySelector('[data-field-problem="name"]')?.textContent).toBe('Check this value.');
    expect(received[0].get('companyId')).toBe(COMPANY_B);
  });
});

describe('restoreFormValues — a re-rendered form gets the refused values back', () => {
  it('puts text, textarea, selects, repeated selects and checkboxes back; hidden inputs are left alone', () => {
    render(<form data-testid="f"><NewPositionFields /></form>);
    const form = screen.getByTestId('f') as HTMLFormElement;
    restoreFormValues(form, {
      companyId: ['ignored'], title: ['Fictional analyst'], description: ['Line one'], jobGradeIds: [G1, G2], workLocation: ['KL'], recruitmentType: ['budgeted'],
      [`cf.${CF_TEXT}`]: ['Fixed'], [`cf.${CF_MULTI}`]: [OPT_A], interviewPlanFormIds: [FORM1, FORM2, '', ''],
    });
    expect([value('Job title'), value('Job description'), value('Work location'), value('Recruitment type'), value('Shift pattern')])
      .toEqual(['Fictional analyst', 'Line one', 'KL', 'budgeted', 'Fixed']);
    expect([checked('Grade 1'), checked('Grade 2'), checked('Malay'), checked('English'), checked('Archive after reject')]).toEqual([true, true, true, false, false]);
    expect([1, 2, 3, 4].map((n) => value(`Round ${n}`))).toEqual([FORM1, FORM2, '', '']);
    expect((form.querySelector('input[name="companyId"]') as HTMLInputElement).value).toBe(COMPANY_B);
  });
  it('formValuesOf keeps every value of a repeated name in order and leaves React\'s action keys out', () => {
    const f = new FormData();
    for (const [k, v] of [['$ACTION_ID_x', ''], ['interviewPlanFormIds', FORM1], ['interviewPlanFormIds', ''], ['title', 'T']]) f.append(k, v);
    expect(formValuesOf(f)).toEqual({ interviewPlanFormIds: [FORM1, ''], title: ['T'] });
  });
});
