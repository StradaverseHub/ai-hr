import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const timeout = 90000;
const dataset = 'attendance_ot';
const newBuilder = '/reports/builder/new?dataset=attendance_ot';
const hub = '/reports?cat=attendance';
const builderPath = /^\/reports\/builder\/([0-9a-f-]{36})$/;

export async function exerciseSavedReport({ page, user, fixture, db, base, phase, thinkTimeMs, report, save, loadState, waitForFirstWrite }) {
  assert.equal(base, 'https://localhost:3443');
  assert.equal(user.role, 'groupHR');
  assert.equal(fixture.users[user.index]?.userId, user.userId);
  const tenantId = fixture.tenants[user.tenant].tenantId;
  const name = 'PERF_REPORT_' + randomUUID();
  const edited = name + '_EDITED';
  const timings = [];
  let step = 'open builder';
  let reportId;
  let deleted = false;

  const owned = () => db`
    select id, name, dataset_id, shared, spec from custom_report
    where tenant_id=${tenantId}::uuid and created_by_user_id=${user.userId}::uuid
      and name in (${name},${edited})
  `;
  const open = async path => {
    const response = await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout });
    assert(response?.ok());
    const skip = page.getByRole('dialog').getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible()) {
      await skip.click({ timeout });
      await skip.waitFor({ state: 'hidden', timeout });
    }
  };
  const reportName = page.getByRole('textbox', { name: 'Report name', exact: true });
  const saveButton = page.getByRole('button', { name: 'Save report', exact: true });
  const link = id => page.locator('main').getByRole('link', { name: edited, exact: false })
    .and(page.locator('a[href="/reports/builder/' + id + '"]'));

  async function fillName(value) {
    const deadline = performance.now() + timeout;
    const submittedName = page.locator('main form input[type="hidden"][name="name"]');
    while (performance.now() < deadline) {
      await reportName.fill('', { timeout: Math.max(1, deadline - performance.now()) });
      await reportName.fill(value, { timeout: Math.max(1, deadline - performance.now()) });
      if (await submittedName.inputValue({ timeout: Math.max(1, deadline - performance.now()) }) === value) return;
      await pause(100);
    }
    throw new Error('Report name did not reach its hydrated save form');
  }

  async function record(operation, action) {
    const startedMs = performance.now();
    const startedWith = loadState?.();
    await action();
    timings.push({ operation, startedMs, visibleByMs: performance.now() - startedMs, startedWith, completedWith: loadState?.() });
  }

  async function remove(id, measured) {
    await open(hub);
    if (measured) await link(id).waitFor({ state: 'visible', timeout });
    const rowLink = page.locator('main a[href="/reports/builder/' + id + '"]');
    await rowLink.waitFor({ state: 'visible', timeout });
    const row = page.locator('main li').filter({ has: page.locator('a[href="/reports/builder/' + id + '"]') });
    await row.getByRole('button', { name: 'Actions', exact: true }).click({ timeout });
    const deleteButton = row.getByRole('button', { name: 'Delete', exact: true });
    await deleteButton.waitFor({ state: 'visible', timeout });
    const perform = async () => {
      const confirm = dialog => dialog.accept();
      page.once('dialog', confirm);
      try {
        await Promise.all([
          page.waitForURL(url => url.pathname === '/reports' && url.searchParams.get('toast') === 'Report deleted', { timeout }),
          deleteButton.click({ timeout }),
        ]);
        await page.getByText('Report deleted', { exact: true }).waitFor({ state: 'visible', timeout });
      } finally {
        page.off('dialog', confirm);
      }
    };
    if (measured) await record('delete', perform);
    else await perform();
    assert.equal((await owned()).length, 0, 'report definition was not removed');
    deleted = true;
  }

  try {
    await open(newBuilder);
    await page.getByRole('heading', { name: 'New custom report', exact: true }).waitFor({ state: 'visible', timeout });
    await fillName(name);
    step = 'create';
    await waitForFirstWrite?.();
    await record('create', async () => {
      await Promise.all([
        page.waitForURL(url => builderPath.test(url.pathname) && url.searchParams.get('toast') === 'Report created', { timeout }),
        saveButton.click({ timeout }),
      ]);
      await page.getByText('Report created', { exact: true }).waitFor({ state: 'visible', timeout });
    });
    reportId = builderPath.exec(new URL(page.url()).pathname)?.[1];
    assert(reportId);
    const [created, duplicate] = await owned();
    assert(created && !duplicate && created.id === reportId && created.name === name);
    assert.equal(created.dataset_id, dataset);
    assert.equal(created.shared, false);
    assert(created.spec.columns.includes('employeeCode') && created.spec.columns.includes('recordedOtMinutes'));
    assert.equal(created.spec.layout.orientation, 'landscape');

    if (phase === 'loaded') await pause(thinkTimeMs);
    step = 'edit';
    await fillName(edited);
    const orientation = page.locator('main select').filter({ has: page.locator('option[value="portrait"]') });
    await orientation.selectOption('portrait', { timeout });
    await record('edit', async () => {
      await Promise.all([
        page.waitForURL(url => url.pathname === '/reports/builder/' + reportId && url.searchParams.get('toast') === 'Report saved', { timeout }),
        saveButton.click({ timeout }),
      ]);
      await page.getByText('Report saved', { exact: true }).waitFor({ state: 'visible', timeout });
    });
    const [updated, unexpected] = await owned();
    assert(updated && !unexpected && updated.id === reportId && updated.name === edited);
    assert.equal(updated.dataset_id, dataset);
    assert.equal(updated.shared, false);
    assert.equal(updated.spec.layout.orientation, 'portrait');
    assert.deepEqual(updated.spec.columns, created.spec.columns);

    if (phase === 'loaded') await pause(thinkTimeMs);
    step = 'delete';
    await remove(reportId, true);
    step = 'verify audit';
    const events = await db`
      select event_type, payload->>'name' as name from domain_event
      where tenant_id=${tenantId}::uuid and aggregate_type='custom-report'
        and aggregate_id=${reportId}::uuid and actor_id=${user.userId}::uuid
        and actor_type='user' order by sequence
    `;
    assert.deepEqual(events.map(row => row.event_type), ['custom-report.created', 'custom-report.updated', 'custom-report.deleted']);
    assert.deepEqual(events.map(row => row.name), [name, edited, edited]);
    (report.browserSavedReportJourneys ??= []).push({ phase, role: user.role, dataset, status: 'passed', persisted: true, auditEvents: events.length, timings });
    save();
  } catch (error) {
    let cleanup = deleted ? 'deleted' : 'absent';
    if (!deleted) {
      try {
        const rows = await owned();
        if (rows.length === 1 && rows[0].dataset_id === dataset && rows[0].shared === false) {
          await remove(rows[0].id, false);
          cleanup = 'deleted';
        } else if (rows.length) {
          cleanup = 'ambiguous';
        }
      } catch {
        cleanup = 'failed';
      }
    }
    (report.browserSavedReportJourneys ??= []).push({ phase, role: user.role, dataset, status: 'failed', step, errorType: error.name, cleanup, timings });
    save();
    throw new Error('Saved report browser journey failed during ' + step, { cause: error });
  }
}
