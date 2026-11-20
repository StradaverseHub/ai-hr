import assert from 'node:assert/strict';

const requiredByAudience = {
  employee: {
    'today-calendar': '[data-today-month]',
    'today-requests': '[data-today-requests-all]',
    'today-notices': 'a[href="/notices"]',
    'today-coming-up': '',
  },
  manager: {
    'today-decide': ':is([data-today-empty],[data-today-decisions],[data-today-other-work])',
    'today-team-coming-up': '',
    'today-own': ':is([data-today-own],[data-today-own-choose])',
  },
  administrator: {
    'today-needs': ':is([data-today-empty],[data-today-needs-list])',
    'today-handled': ':is([data-today-empty],[data-today-handled])',
    'today-readiness': '',
    'today-watching': '',
    'today-own': ':is([data-today-own],[data-today-own-choose])',
  },
};

export async function waitForTodayBrowserReadiness(page, role, timeout) {
  const audience = role === 'employee' || role === 'manager' ? role : 'administrator';
  const today = page.locator(`main [data-today="${audience}"]`);
  const date = today.locator('header [data-today-date]');
  await date.waitFor({ state: 'visible', timeout: timeout() });
  assert.match(await date.getAttribute('data-today-date') ?? '', /^\d{4}-\d{2}-\d{2}$/);
  const required = Object.entries(requiredByAudience[audience]);
  for (const [id, content] of required) {
    const panel = today.locator(`[data-today-panel="${id}"]`);
    await (content ? panel.locator(content).first() : panel).waitFor({ state: 'visible', timeout: timeout() });
  }
  await today.locator('[data-today-skeleton]:visible, [data-recommendation-pending]:visible')
    .first().waitFor({ state: 'hidden', timeout: timeout() });
  const panels = await today.locator('[data-today-panel]:visible').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-today-panel')).sort(),
  );
  assert.equal(panels.length, new Set(panels).size, 'Today rendered duplicate panel identities');
  return { panels, required: required.map(([id]) => id).sort() };
}
