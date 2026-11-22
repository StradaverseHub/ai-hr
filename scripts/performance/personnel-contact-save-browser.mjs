import assert from 'node:assert/strict';

/** Exercise the existing database-verified save, restore and discard journey on the observed page. */
export async function exercisePersonnelContactSave({base, page, user, fixture, db, report, save}) {
  assert(['groupHR', 'companyHR'].includes(user.role));
  const tenantId = fixture.tenants[user.tenant].tenantId;
  const actor = {...user, tenantId};
  const employee = fixture.users.find(person => person.role === 'employee' && person.tenant === user.tenant && person.companyId === user.companyId);
  assert(employee, 'Expected an authorized fictional Personnel record');
  const subject = {...employee, tenantId};
  const path = '/admin/personnel/' + subject.employmentId + '?tab=profile';
  const response = await page.goto(base + path, {waitUntil: 'commit', timeout: 15000});
  assert.equal(response?.status(), 200);
  assert.equal(page.url(), base + path);
  await page.getByRole('heading', {name: subject.name, level: 1, exact: true}).waitFor({timeout: 15000});
  await verifyPersonnelContactSave(page, db, {actor, subject}, report, save);
}

async function verifyPersonnelContactSave(page, db, entry, report, save) {
  const { actor, subject } = entry;
  assert.equal(subject.tenantId, actor.tenantId);
  assert.equal(subject.companyId, actor.companyId);
  const readContact = async () => {
    const [row] = await db`select p.home_phone from employment e
      join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
      where e.id=${subject.employmentId}::uuid and e.tenant_id=${actor.tenantId}::uuid
        and e.company_id=${actor.companyId}::uuid and e.voided_at is null and e.terminated_on is null`;
    assert(row, 'Expected the scoped fictional Personnel record');
    return row.home_phone;
  };
  const original = await readContact();
  const marker = '03-9000' + String(actor.index).padStart(4, '0');
  assert.notEqual(original, marker);
  const result = { role: actor.role, steps: [], outcome: 'failed' };
  (report.personnelProfileActions ??= []).push(result);
  const profile = page.locator('main [data-tab-save-scope="profile"]:visible');
  const phoneSelector = 'form[data-save-section="contact"] input#perm-home-phone[name="homePhone"]';
  const phone = profile.locator(phoneSelector);
  const button = profile.getByRole('button', { name: 'Save Changes', exact: true });
  const dirty = profile.locator('[data-tab-save-count]');
  const timeout = 15000;

  async function submit(name, value) {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    await phone.fill(value ?? '', { timeout });
    await dirty.waitFor({ state: 'visible', timeout });
    const timings = { dirtyVisibleMs: elapsed() };
    const pathname = new URL(page.url()).pathname;
    let actionRequest;
    const requested = request => {
      if (actionRequest || request.method() !== 'POST' || !request.headers()['next-action'] ||
          new URL(request.url()).pathname !== pathname) return;
      actionRequest = request;
      timings.actionRequestMs = elapsed();
    };
    const responded = response => {
      if (actionRequest && response.request() === actionRequest) timings.actionHeadersMs = elapsed();
    };
    const completed = request => {
      if (actionRequest && request === actionRequest) timings.actionBodyMs = elapsed();
    };
    page.on('request', requested);
    page.on('response', responded);
    page.on('requestfinished', completed);
    try {
      await button.click({ timeout });
      timings.clickReturnedMs = elapsed();
      await dirty.waitFor({ state: 'hidden', timeout });
      timings.dirtyClearedMs = elapsed();
      assert.equal(await profile.getByRole('alert').count(), 0, 'Personnel Save showed an error');
      assert.equal(await readContact(), value, 'Personnel Save did not persist through its owner');
      result.steps.push({ name, persistedMs: elapsed(), timings });
      save();
    } finally {
      page.off('request', requested);
      page.off('response', responded);
      page.off('requestfinished', completed);
    }
  }

  try {
    await page.waitForLoadState('load', { timeout });
    assert.equal(await phone.inputValue({ timeout }), original ?? '');
    try {
      await submit('save', marker);
    } finally {
      if ((await readContact()) === marker) await submit('restore', original);
    }
    assert.equal(await readContact(), original);
    assert.deepEqual(result.steps.map(step => step.name), ['save', 'restore']);
    const discardStarted = performance.now();
    await phone.fill(marker, { timeout });
    await dirty.waitFor({ state: 'visible', timeout });
    await profile.getByRole('button', { name: 'Discard Changes', exact: true }).click({ timeout });
    await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value,
      { selector: phoneSelector, value: original ?? '' }, { timeout });
    await dirty.waitFor({ state: 'hidden', timeout });
    assert.equal(await readContact(), original, 'Discard must leave the last persisted value intact');
    result.discardMs = Math.round(performance.now() - discardStarted);
    result.outcome = 'passed';
  } finally {
    save();
  }
}
