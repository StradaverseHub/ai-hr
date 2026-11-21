import assert from 'node:assert/strict';

const nameControl = 'form[data-save-section="person"] input[data-personnel-field="profile.personal_details.fullname"]';
const profilePanel = '[data-tabpanel="profile"]';
const familyPanel = '[data-tabpanel="family"]';

export async function measurePersonnelProfileActions({ db, fixture, origin, signedInContext, report, save }) {
  const [group, company] = fixture.users;
  assert.equal(group.role, 'groupHR');
  assert.equal(company.role, 'companyHR');
  assert.equal(group.companyId, company.companyId);
  const subject = fixture.users.find(user => user.role === 'employee' && user.companyId === company.companyId);
  assert(subject, 'Expected the fictional Personnel employee');
  const [employee] = await db`select person_id from employment where id=${subject.employmentId}::uuid
    and company_id=${company.companyId}::uuid and tenant_id=${company.tenantId}::uuid`;
  assert(employee?.person_id, 'Expected the fictional employee to have a saved person record');
  const url = origin + '/admin/personnel/' + subject.employmentId;
  const actions = report.personnelProfileActions = [];

  for (const actor of [group, company]) {
    const context = await signedInContext(actor);
    const result = { role: actor.role, outcome: 'missing', step: 'open', actions: [] };
    actions.push(result);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const [stored] = await db`select full_name from person where id=${employee.person_id}::uuid
        and tenant_id=${actor.tenantId}::uuid`;
      assert.equal(stored?.full_name, subject.name);
      const readState = async () => {
        const [row] = await db`select p.full_name, count(d.id)::int as events,
            count(d.id) filter(where d.actor_id=${actor.userId}::uuid)::int as actor_events
          from person p left join domain_event d on d.tenant_id=p.tenant_id and d.aggregate_id=p.id
            and d.aggregate_type='person' and d.event_type='person.updated'
          where p.id=${employee.person_id}::uuid and p.tenant_id=${actor.tenantId}::uuid
          group by p.full_name`;
        return row;
      };
      const before = await readState();
      assert.equal((await page.goto(url, { waitUntil: 'commit', timeout: 15000 }))?.status(), 200);
      const profile = page.locator(profilePanel);
      const family = page.locator(familyPanel + ' #section-family');
      const name = profile.locator(nameControl);
      const tab = key => page.locator(`button[role="tab"][aria-controls$="-panel-${key}"]`);
      const editor = button => profile.getByRole('button', { name: button, exact: true });
      const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
      const setName = value => name.fill(value);
      const expectName = value => page.waitForFunction(
        ({ selector, expected }) => document.querySelector(selector)?.value === expected,
        { selector: nameControl, expected: value },
      );
      const timed = async (action, trigger, witness) => {
        result.step = action;
        const started = performance.now();
        await trigger();
        await witness();
        result.actions.push({ action, usableMs: Math.round(performance.now() - started) });
        save();
      };
      await name.waitFor({ state: 'visible' });
      assert.equal(await name.inputValue(), subject.name);
      result.familyContentOnProfile = await family.count() > 0;
      await timed('open Family tab', () => tab('family').click(), () => family.waitFor({ state: 'visible' }));
      assert.equal(new URL(page.url()).searchParams.get('tab'), 'family');
      await timed('return to Profile', () => tab('profile').click(), () => name.waitFor({ state: 'visible' }));

      const editedName = subject.name + ' Browser check';
      await setName(editedName);
      await profile.locator('button:enabled:text-is("Save Changes")').waitFor();
      await timed('warn before leaving an edited tab', () => tab('family').click(), () => dialog.waitFor());
      await timed('cancel the tab switch', () => dialog.getByRole('button', { name: 'Cancel', exact: true }).click(),
        () => dialog.waitFor({ state: 'hidden' }));
      assert.equal(await name.inputValue(), editedName);
      assert.equal(new URL(page.url()).searchParams.get('tab'), 'profile');

      await tab('family').click();
      await timed('discard and open Family', () => dialog.getByRole('button', { name: 'Discard Changes', exact: true }).click(),
        () => family.waitFor({ state: 'visible' }));
      assert.deepEqual(await readState(), before);
      await tab('profile').click();
      await name.waitFor({ state: 'visible' });
      await expectName(subject.name);

      const heading = fullName => page.locator('main').getByRole('heading', { name: fullName, exact: true, level: 1 });
      const persist = async (action, value, writes) => {
        await setName(value);
        await timed(action, () => editor('Save Changes').click(), () => heading(value).waitFor());
        assert.deepEqual(await readState(), {
          full_name: value, events: before.events + writes, actor_events: before.actor_events + writes,
        });
      };
      await persist('save Profile', editedName, 1);
      await persist('restore Profile', subject.name, 2);
      result.outcome = 'observed';
    } catch (error) {
      result.outcome = error.name === 'TimeoutError' ? 'timeout'
        : error.code === 'ERR_ASSERTION' ? 'assertion' : 'browser-failure';
    } finally {
      await context.close();
      save();
    }
  }
  assert(actions.every(result => result.outcome === 'observed'), 'A Personnel Profile action missed its browser or database witness');
}
