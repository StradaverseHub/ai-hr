/**
 * 597c810a — THE PHOTO IN THE LIST AVATAR, RENDERED.
 *
 * The reporter asked for the employee's uploaded photo where the initials are today, on the Personnel
 * Management list and on the employee directory, with initials kept for everybody who has no photo. Two
 * things about that are only checkable by rendering:
 *
 *   1. THE ROW MUST ISSUE NO PHOTO REQUEST FOR SOMEBODY WITH NO PHOTO. That is not a nicety — production
 *      holds 89 persons and 2 photos, so the naive "put an <img> on every row and let it 404" costs 87
 *      pointless requests per list load, each after a session read and an RLS query. A source scan sees an
 *      `<Avatar>` either way; only the markup shows whether an `<img src>` was emitted.
 *   2. THE OTHER ELEVEN CALL SITES MUST BE UNTOUCHED. `src` is optional so attendance, user admin, the org
 *      chart, the leave screens and the user menu keep their initials with no edit. A rendered Avatar with
 *      no `src` must still be the initials span it has always been.
 *
 * Storage, the access rule and the bulk existence read are server-side and proved by
 * test/person-photo.test.ts and test/person-photo-bulk-597c810a.test.ts. Nothing here re-proves them; in
 * particular nothing here decides WHO has a photo — the row is handed that answer.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Avatar } from '../components/ui';
import { EmployeeRow, type EmployeeRowProps } from '../app/admin/personnel/employee-row';
import type { EmployeeColumnKey } from '../lib/employee-columns';

const COLUMNS: EmployeeColumnKey[] = ['code', 'name', 'status'];

const rowProps = (over: Partial<EmployeeRowProps> = {}): EmployeeRowProps => ({
  employmentId: 'emp-1',
  name: 'Aisha Rahman',
  email: 'aisha@t.local',
  employeeCode: 'E001',
  status: 'active',
  statusLabel: 'Active',
  columns: COLUMNS,
  text: { code: 'E001', status: 'Active' },
  ...over,
});

/** The row is a <tr>, so it needs a legal table parent — the precedent in test/personnel-row-click. */
const renderRow = (over: Partial<EmployeeRowProps> = {}) =>
  renderToStaticMarkup(
    createElement('table', null, createElement('tbody', null, createElement(EmployeeRow, rowProps(over)))),
  );

describe('Avatar — initials by default, a photo only when one is supplied', () => {
  it('with NO src it is the initials span, exactly as the other eleven call sites still render it', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Aisha Rahman' }));
    expect(html).toContain('AR');
    expect(html, 'an Avatar with no src must not emit an image at all').not.toContain('<img');
  });

  it('an explicitly null/undefined src is the same as none (a caller may pass the absent case through)', () => {
    for (const src of [null, undefined]) {
      const html = renderToStaticMarkup(createElement(Avatar, { name: 'Aisha Rahman', src }));
      expect(html).toContain('AR');
      expect(html).not.toContain('<img');
    }
  });

  it('with a src it renders that image, cropped to the circle, and drops the initials', () => {
    const html = renderToStaticMarkup(
      createElement(Avatar, { name: 'Aisha Rahman', src: '/personnel/photo/p-1' }),
    );
    expect(html).toContain('src="/personnel/photo/p-1"');
    expect(html, 'the face must stay centred in the circle at any size class').toContain('object-cover');
    expect(html).toContain('rounded-full');
    expect(html, 'the initials are the FALLBACK, not a caption under the photo').not.toContain('AR');
  });

  it('the caller keeps control of the size class in both branches (the list uses the default, the header size-24)', () => {
    for (const src of [undefined, '/personnel/photo/p-1']) {
      const html = renderToStaticMarkup(createElement(Avatar, { name: 'Aisha Rahman', src, className: 'size-24' }));
      expect(html).toContain('size-24');
    }
  });
});

describe('the Personnel list row', () => {
  it('a person with NO photo renders initials and issues NO photo request', () => {
    const html = renderRow();
    expect(html).toContain('AR');
    expect(
      html,
      'an <img> on every row is 87 pointless 404s per load on production — the whole reason for the bulk read',
    ).not.toContain('/personnel/photo/');
    expect(html).not.toContain('<img');
  });

  it('a person WITH a photo renders it from the person-keyed serve route', () => {
    const html = renderRow({ photoPersonId: 'person-9' });
    expect(html).toContain('src="/personnel/photo/person-9"');
    expect(html).toContain('object-cover');
    expect(html, 'the photo replaces the initials, it does not sit beside them').not.toContain('>AR<');
  });

  it('an explicit null photoPersonId is the no-photo case, not a request for /personnel/photo/null', () => {
    const html = renderRow({ photoPersonId: null });
    expect(html).not.toContain('/personnel/photo/');
    expect(html).toContain('AR');
  });

  it('everything else about the row is unchanged — name link, email, code and status all still render', () => {
    const html = renderRow({ photoPersonId: 'person-9' });
    expect(html).toContain('Aisha Rahman');
    expect(html).toContain('aisha@t.local');
    expect(html).toContain('E001');
    expect(html).toContain('Active');
    expect(html).toContain('href="/admin/personnel/emp-1?from=personnel"');
  });
});
