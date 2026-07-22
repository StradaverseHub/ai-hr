/**
 * 911b2886 — Pay Items list/maintenance split: static wiring assertions (source-assertion convention,
 * cf. test/personnel-payroll-tab-order.test.ts).
 *
 * The genuinely risky logic (the create-mode duplicate guard) has behavioural DB tests in
 * test/pay-component-create-guard.test.ts; this file pins the UI split's plumbing — the list page no
 * longer embeds the maintenance form, the dedicated /new and /[code] routes render the shared
 * ComponentForm, the actions carry their own error-redirect targets with success redirects OUTSIDE the
 * try (redirect() throws NEXT_REDIRECT — a success redirect inside try would be swallowed by catch and
 * re-surface as a spurious error toast), and both routes are registered in the permissions matrix.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'app', 'admin', 'pay-components');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

const listSrc = read(DIR, 'page.tsx');
const newSrc = read(DIR, 'new', 'page.tsx');
const editSrc = read(DIR, '[code]', 'page.tsx');
const formSrc = read(DIR, 'component-form.tsx');
const actionsSrc = read(DIR, 'actions.ts');
const permsSrc = read(__dirname, '..', 'lib', 'permissions.ts');

/** Slice one exported server action out of actions.ts (from its header to the next export or EOF). */
function actionBody(name: string): string {
  const start = actionsSrc.indexOf(`export async function ${name}`);
  expect(start, `${name} not found in actions.ts`).toBeGreaterThan(-1);
  const rest = actionsSrc.slice(start + 1);
  const next = rest.search(/\nexport /);
  return actionsSrc.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe('911b2886 — Pay Items list page is list-only', () => {
  it('no longer imports the PayRuleEditor island or renders the inline maintenance form', () => {
    expect(listSrc).not.toContain('PayRuleEditor');
    expect(listSrc).not.toContain('upsertComponentAction');
    expect(listSrc).not.toContain('createComponentAction'); // the form (and its action) lives on the routes
    expect(listSrc).not.toContain('ComponentForm');
  });

  it('links Create New to the /new route and row Edit to the [code] route', () => {
    expect(listSrc).toContain('href={`${PAGE}/new`}');
    expect(listSrc).toContain('href={`${PAGE}/${encodeURIComponent(c.code)}`}');
  });

  it('keeps the legacy ?edit= / ?new=1 URLs working via redirects to the dedicated routes', () => {
    expect(listSrc).toContain('redirect(`${PAGE}/${encodeURIComponent(sp.edit)}`)');
    expect(listSrc).toContain('redirect(`${PAGE}/new`)');
  });
});

describe('911b2886 — dedicated maintenance routes', () => {
  it('/new renders ComponentForm keyed off the fresh nonce (Save & New must remount the island)', () => {
    expect(newSrc).toContain('ComponentForm');
    expect(newSrc).toMatch(/key=\{fresh/);
    expect(newSrc).toContain('component={null}');
  });

  it('/[code] renders ComponentForm pre-filled and 404s on an unknown code', () => {
    expect(editSrc).toContain('ComponentForm');
    expect(editSrc).toContain('notFound()');
    expect(editSrc).toContain('component={component}');
  });

  it('the shared form posts to createComponentAction (create) / updateComponentAction (edit) and keeps the code read-only on edit', () => {
    expect(formSrc).toContain('editing ? updateComponentAction : createComponentAction');
    expect(formSrc).toContain('readOnly={editing}');
    expect(formSrc).toContain("name=\"intent\" value=\"saveAndNew\"");
    expect(formSrc).toContain('ErrorBanner');
  });
});

describe('911b2886 — action redirect plumbing (NEXT_REDIRECT-safe)', () => {
  it('defines the two split actions and no legacy upsert action', () => {
    expect(actionsSrc).toContain('export async function createComponentAction');
    expect(actionsSrc).toContain('export async function updateComponentAction');
    expect(actionsSrc).not.toContain('upsertComponentAction');
  });

  it('create fails back to /new; its success redirect sits OUTSIDE the try block', () => {
    const body = actionBody('createComponentAction');
    const catchAt = body.indexOf('catch');
    expect(catchAt).toBeGreaterThan(-1);
    // error target inside the catch block
    expect(body.indexOf('${PAGE}/new?error=')).toBeGreaterThan(catchAt);
    // success redirects (Save & New target + list toast) come after the catch closes
    expect(body.indexOf('saveAndNewTarget')).toBeGreaterThan(body.indexOf('${PAGE}/new?error='));
    expect(body.indexOf("back(t('toastSaved'))")).toBeGreaterThan(catchAt);
  });

  it('update fails back to its own [code] route; its success redirect sits OUTSIDE the try block', () => {
    const body = actionBody('updateComponentAction');
    const catchAt = body.indexOf('catch');
    expect(catchAt).toBeGreaterThan(-1);
    expect(body.indexOf('${PAGE}/${encodeURIComponent(input.code)}?error=')).toBeGreaterThan(catchAt);
    expect(body.indexOf('saveAndNewTarget')).toBeGreaterThan(body.indexOf('?error='));
    expect(body.indexOf("back(t('toastSaved'))")).toBeGreaterThan(catchAt);
  });

  it('Save & New redirects to /new with a fresh nonce that survives ToastFromQuery', () => {
    expect(actionsSrc).toContain('fresh=${Date.now()}');
    expect(actionsSrc).toContain('/new?toast=');
  });
});

describe('911b2886 — permissions matrix registers the new routes', () => {
  it('payComponents covers the list, /new and /[code] routes', () => {
    expect(permsSrc).toContain("'/admin/pay-components/new'");
    expect(permsSrc).toContain("'/admin/pay-components/[code]'");
  });
});
