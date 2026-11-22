/** Run real Lifecycle commands against the record census's disposable fixtures. */
import assert from 'node:assert/strict';

export async function measureLifecycleRecordActions({ db, fixture, origin, signedInContext, report, save, observeAction }) {
  const [group, company] = fixture.users;
  const { asset, model, offboarding, request } = fixture.lifecycleRecords;
  const updatedModel = model + ' updated';
  const actions = [
    {
      name: 'edit asset model', actor: group, path: '/lifecycle/assets/' + asset.code,
      template: '/lifecycle/assets/[code]',
      id: asset.id, refType: 'asset', history: 'asset.edited',
      before: model, after: updatedModel,
      async read() {
        const [row] = await db`select model from it_asset where id=${asset.id}::uuid
          and tenant_id=${group.tenantId}::uuid and company_id=${company.companyId}::uuid`;
        return row.model;
      },
      async prepare(page) {
        const editor = page.locator('details:has(input[name="model"])');
        await editor.locator('summary').click();
        await editor.locator('input[name="model"]').fill(updatedModel);
        return editor.getByRole('button', { name: 'Save', exact: true });
      },
      ready: page => page.locator('main').getByText(updatedModel).first(),
    },
    {
      name: 'record offboarding outcome', actor: company, path: '/lifecycle/offboarding/' + offboarding.number,
      template: '/lifecycle/offboarding/[number]',
      id: offboarding.id, refType: 'case', history: 'outcome.set',
      before: 'pending', after: 'rejected',
      async read() {
        const [row] = await db`select outcome from lc_case where id=${offboarding.id}::uuid
          and tenant_id=${company.tenantId}::uuid and company_id=${company.companyId}::uuid`;
        return row.outcome;
      },
      prepare: page => page.locator('main button[name="outcome"][value="rejected"]'),
      ready: page => page.locator('main').getByText(
        'Rejected: the processing steps do not apply and the retention steps are open.', { exact: true }),
    },
    {
      name: 'assign asset request handler', actor: company, path: '/lifecycle/asset-requests/' + request.number,
      template: '/lifecycle/asset-requests/[number]',
      id: request.id, refType: 'asset_request', history: 'request.handler',
      before: null, after: company.userId,
      async read() {
        const [row] = await db`select handler_user_id from it_asset_request where id=${request.id}::uuid
          and tenant_id=${company.tenantId}::uuid and company_id=${company.companyId}::uuid`;
        return row.handler_user_id;
      },
      async prepare(page) {
        const form = page.locator('main form:has(select[name="handler"])');
        await form.locator('select[name="handler"]').selectOption(company.userId);
        return form.getByRole('button', { name: 'Save', exact: true });
      },
      ready: page => page.locator('main').getByText('Handler set', { exact: true }),
    },
  ];

  const results = report.lifecycleRecordActions = [];
  for (const action of actions) {
    const result = { action: action.name, role: action.actor.role, outcome: 'missing', step: 'before' };
    results.push(result);
    let context;
    try {
      assert.equal(await action.read(), action.before);
      const history = () => db`select actor_user_id from lc_history
        where tenant_id=${action.actor.tenantId}::uuid and ref_id=${action.id}::uuid
          and ref_type=${action.refType} and action=${action.history}`;
      assert.equal((await history()).length, 0);

      result.step = 'open';
      context = await signedInContext(action.actor);
      const page = await context.newPage();
      const url = origin + action.path;
      assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }))?.status(), 200);
      assert.equal(page.url(), url);
      page.setDefaultTimeout(15000);
      result.step = 'prepare';
      const button = await action.prepare(page);
      assert.equal(await action.ready(page).isVisible(), false);
      await button.waitFor({ state: 'visible' });

      result.step = 'submit';
      const started = performance.now();
      await observeAction(page, action.path, action.template, result, async () => {
        await button.click();
        await action.ready(page).waitFor({ state: 'visible', timeout: Math.max(1, 15000 - (performance.now() - started)) });
        result.usableMs = Math.round(performance.now() - started);
        assert.equal(page.url(), url);

        result.step = 'verify';
        assert.equal(await action.read(), action.after);
        assert.deepEqual((await history()).map(row => row.actor_user_id), [action.actor.userId]);
      });
      result.outcome = 'observed';
    } catch (error) {
      result.outcome = error.name === 'TimeoutError' ? 'timeout'
        : error.code === 'ERR_ASSERTION' ? 'assertion' : 'browser-failure';
    } finally {
      if (context) await context.close();
      save();
    }
  }
  assert(results.every(row => row.outcome === 'observed'), 'A Lifecycle action missed its visible or committed outcome');
}
