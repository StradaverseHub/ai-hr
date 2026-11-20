import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { performanceFixtureCalendar } from './fixture-workload.mjs';

export async function measureOwnPayslipDetail({ base, page, user, fixture, db, report, save }) {
  assert.equal(user.role, 'employee');
  const { historicalMonth } = performanceFixtureCalendar(fixture.today);
  report.actionStage = 'released-payslip-fixture';
  const slips = await db`
    select slip.id, slip.net_pay, employment.employee_code, company.legal_name
    from payslip slip
    join payroll_batch batch on batch.id=slip.batch_id and batch.tenant_id=slip.tenant_id
    join employment on employment.id=slip.employment_id and employment.tenant_id=slip.tenant_id
    join company on company.id=batch.company_id and company.tenant_id=batch.tenant_id
    where slip.tenant_id=${user.tenantId}::uuid and slip.employment_id=${user.employmentId}::uuid
      and employment.person_id=${user.personId}::uuid and batch.pay_period=${historicalMonth}
      and batch.released_at<=now()
  `;
  assert.equal(slips.length, 1, 'Expected one released historical payslip for the signed-in employee');
  const slip = slips[0];
  const net = Number(slip.net_pay);
  assert(Number.isFinite(net) && net > 0);
  const period = new Intl.DateTimeFormat('en', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(historicalMonth + '-01T00:00:00Z'));
  const expectedNet = 'RM ' + net.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const path = '/me/payslip/' + slip.id;
  const main = page.locator('main:visible');
  const auditCount = async () => {
    const [row] = await db`
      select count(*)::int as total,
        count(*) filter (where actor_id=${user.userId}::uuid
          and subject_employment_id=${user.employmentId}::uuid and payload->>'channel'='web'
          and payload->>'payPeriod'=${historicalMonth} and chain_seq is not null and hash is not null)::int as matching
      from domain_event where tenant_id=${user.tenantId}::uuid and aggregate_id=${slip.id}::uuid
        and aggregate_type='payslip' and event_type='payslip.opened'
    `;
    return row;
  };

  const initial = await auditCount();
  report.payslipDetailSteps = [];
  for (const pass of ['first', 'repeat']) {
    const started = performance.now();
    const deadline = started + 15000;
    const timeout = () => Math.max(1, Math.floor(deadline - performance.now()));
    report.actionStage = 'released-payslip-document';
    const response = await page.goto(base + path, { waitUntil: 'commit', timeout: timeout() });
    assert.equal(response?.status(), 200);
    assert.equal(new URL(page.url()).pathname, path);
    report.actionStage = 'released-payslip-content';
    await main.getByRole('heading', { name: 'Payslip · ' + period, exact: true }).waitFor({ timeout: timeout() });
    await main.getByText(`${slip.employee_code} · ${user.name} · ${slip.legal_name}`, { exact: true })
      .waitFor({ timeout: timeout() });
    const netRow = main.getByText('Net pay', { exact: true }).locator('..');
    await netRow.getByText(expectedNet, { exact: true }).waitFor({ timeout: timeout() });
    const pdf = main.getByRole('link', { name: 'Download PDF', exact: true });
    await pdf.waitFor({ timeout: timeout() });
    assert.equal(await pdf.getAttribute('href', { timeout: timeout() }), path + '/pdf');
    const result = { step: 'released-payslip-' + pass, elapsedMs: Math.round(performance.now() - started) };
    report.payslipDetailSteps.push(result);
    save();

    report.actionStage = 'released-payslip-audit';
    const expectedDelta = report.payslipDetailSteps.length;
    const auditDeadline = performance.now() + 5000;
    let count = await auditCount();
    while (count.total < initial.total + expectedDelta && performance.now() < auditDeadline) {
      await pause(100);
      count = await auditCount();
    }
    assert.equal(count.total - initial.total, expectedDelta);
    assert.equal(count.matching - initial.matching, expectedDelta);
    result.auditVerified = true;
    save();
  }
}
