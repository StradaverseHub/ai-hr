/** Run real Lifecycle commands against the record census's disposable fixtures. */
import assert from 'node:assert/strict';
import {serverActionCoverage} from './system-route-manifest.mjs';

export async function measureOffboardingRequisitionSave({db,fixture,origin,signedInContext,registrations,report,save}) {
  const [group,company]=fixture.users;
  const {offboardingId,offboardingItemId,itemName,offboardingNumber}=fixture.lifecycleRequisitions;
  const template='/lifecycle/requisitions/offboarding/[id]';
  const url=origin+'/lifecycle/requisitions/offboarding/'+offboardingId;
  const reason='Fictional account revocation started';
  const result={action:'save offboarding requisition item',template,role:group.role,outcome:'missing',step:'before'};
  report.lifecycleRequisitionAction=result;
  const exercised=new Set();
  const read=async()=>{
    const [state]=await db`
      select c.revision, item->>'status' as status, item->>'reason' as reason,
        coalesce((select jsonb_agg(entry->'actor'->>'id')
          from jsonb_array_elements(coalesce(c.data->'requisitionActivity','[]'::jsonb)) entry
          where entry->>'itemId'=${offboardingItemId} and entry->>'action'='requisition.itemUpdated'
            and entry->>'itemStatus'='progress'), '[]'::jsonb) as actors
      from lc_v9_case c cross join lateral jsonb_array_elements(c.data->'items') item
      where c.id=${offboardingId}::uuid and c.tenant_id=${group.tenantId}::uuid
        and c.company_id=${company.companyId}::uuid and c.module='off' and item->>'id'=${offboardingItemId}
    `;
    return state;
  };
  const timeout=15000;
  let context;
  try {
    const before=await read();
    assert.equal(before?.status,'todo');
    assert.deepEqual(before.actors,[]);
    result.step='open';
    context=await signedInContext(group);
    const page=await context.newPage();
    page.setDefaultTimeout(timeout);
    assert.equal((await page.goto(url,{waitUntil:'load',timeout}))?.status(),200);
    assert.equal(page.url(),url);
    await page.getByRole('heading',{name:offboardingNumber,exact:true}).waitFor();

    result.step='prepare';
    const article=page.locator('article').filter({has:page.getByRole('heading',{name:itemName,exact:true})});
    await article.locator('strong').filter({hasText:/^To do$/}).waitFor();
    await article.locator('select[name="status"]').selectOption('progress');
    await article.locator('input[name="reason"]').fill(reason);
    const button=article.getByRole('button',{name:'Save item',exact:true});
    await button.click({trial:true});

    result.step='submit';
    const started=performance.now();
    const [response]=await Promise.all([
      page.waitForResponse(candidate=>candidate.url()===url&&candidate.request().method()==='POST'&&
        registrations.get(candidate.request().headers()['next-action'])?.has(template),{timeout}),
      button.click(),
    ]);
    result.responseMs=Math.round(performance.now()-started);
    result.httpStatus=response.status();
    assert.equal(response.status(),200);
    await article.locator('strong').filter({hasText:/^In progress$/}).waitFor({
      timeout:Math.max(1,timeout-(performance.now()-started)),
    });
    await article.getByText(reason,{exact:true}).waitFor({
      timeout:Math.max(1,timeout-(performance.now()-started)),
    });
    result.usableMs=Math.round(performance.now()-started);
    assert.equal(page.url(),url);

    result.step='verify';
    const after=await read();
    assert.deepEqual(after,{revision:before.revision+1,status:'progress',reason,actors:[group.userId]});
    exercised.add(response.request().headers()['next-action']);
    result.outcome='observed';
  } catch(error) {
    result.outcome=error.name==='TimeoutError'?'timeout':
      error.code==='ERR_ASSERTION'?'assertion':'browser-failure';
  } finally {
    report.serverActionInventory=serverActionCoverage(registrations,exercised);
    if(context)await context.close();
    save();
  }
  assert.equal(result.outcome,'observed','The offboarding requisition save missed its visible or committed outcome');
}

export async function measureLifecycleRecordActions({ db, fixture, origin, signedInContext, report, save }) {
  const [group, company] = fixture.users;
  const { asset, model, offboarding, request } = fixture.lifecycleRecords;
  const updatedModel = model + ' updated';
  const actions = [
    {
      name: 'edit asset model', actor: group, path: '/lifecycle/assets/' + asset.code,
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
      await button.click();
      await action.ready(page).waitFor({ state: 'visible', timeout: Math.max(1, 15000 - (performance.now() - started)) });
      result.usableMs = Math.round(performance.now() - started);
      assert.equal(page.url(), url);

      result.step = 'verify';
      assert.equal(await action.read(), action.after);
      assert.deepEqual((await history()).map(row => row.actor_user_id), [action.actor.userId]);
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
