/**
 * Organization → Companies: EVERY row reaches the browser, including the ones the RSC payload defers.
 *
 * THE BUG THIS PINS (feedback ae3bd088, "only one company shows"). Production had 8 companies, one
 * group-wide hr_admin grant, and 0 archived. The card header read "Companies (8)", the statutory-gap
 * panel named 5 of them by name — and the list itself drew exactly ONE row. Both totals and the gap
 * panel are computed on the server from the `companies` array, so the array was never the problem. The
 * rows were lost in transit.
 *
 * HOW. The page hands OrganizationList (a client component) an `items` array whose `node` is a
 * server-created <CompanyPanel> element. React's Flight server serialises one payload ROW at a time and
 * keeps a running byte count of the strings written into it. Once that count passes MAX_ROW_SIZE (3200,
 * react-server-dom-*-server.*.js) it stops inlining elements and DEFERS each remaining one into its own
 * payload row, writing `$L<id>` in its place. The Flight CLIENT turns `$L` into
 * `createLazyChunkWrapper(chunk)` — `{ $$typeof: Symbol.for('react.lazy'), _payload, _init }`. React
 * renders that transparently; `isValidElement()` returns FALSE for it.
 *
 * One company panel carries the whole company array, the state catalog and twelve server-action
 * references, so the FIRST row alone puts the counter past 3200 and rows 2..N all arrive as lazies.
 * OrganizationList used to do `isValidElement(it.node) ? cloneElement(it.node, …) : null` — so rows
 * 2..N silently rendered `null`. Hence 8 counted, 1 drawn, and the first one alphabetically at that.
 *
 * WHY THE EXISTING SUITE MISSED IT. Every other test on this screen renders OrganizationList by calling
 * it directly (`renderToStaticMarkup(createElement(OrganizationList, props))`), which never crosses a
 * Flight boundary, so `node` is always a plain element and `isValidElement` is always true. Asserting
 * the rendered markup was necessary but not sufficient: the markup was rendered from props that had not
 * been through the transport that breaks them.
 *
 * SO THIS FILE FEEDS OrganizationList THE POST-TRANSPORT SHAPE. `deferredNode()` builds the exact object
 * the Flight client produces for `$L` (an already-resolved chunk, so react-dom/server can drive it
 * synchronously). The contract asserted is that OrganizationList never inspects `node` — it renders it.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

import { OrganizationList, type OrgListItem } from '../components/organization-list';

const NAMES = [
  'Chin Hin Construction Engineering',
  'Chin Hin Property Group',
  'Demo Group Holdings Bhd',
  'Demo Sdn Bhd',
  'Fiamma (Chin Hin Property)',
  'ISEDECOR BINA SDN BHD',
  'Signature Group of Companies',
  'SpaceX Sdn Bhd',
];

/** A panel node as the Flight client delivers it when the server DEFERRED that element: a React lazy
 *  wrapping an already-resolved chunk, exactly `createLazyChunkWrapper`'s shape. Not an element. */
function deferredNode(node: ReactNode): ReactNode {
  return { $$typeof: Symbol.for('react.lazy'), _payload: node, _init: (p: ReactNode) => p } as never;
}

/** A panel node as the Flight client delivers it when the element was small enough to inline. */
function inlineNode(name: string): ReactNode {
  return createElement('span', { 'data-panel': name }, name);
}

function items(nodeFor: (name: string, index: number) => ReactNode): OrgListItem[] {
  return NAMES.map((name, i) => ({
    id: `company-${i}`,
    name,
    registrationNo: `20230100${i}23`,
    node: nodeFor(name, i),
  }));
}

function render(list: OrgListItem[]): string {
  return renderToStaticMarkup(createElement(OrganizationList, { items: list }));
}

describe('OrganizationList renders every row the page hands it, however Flight delivered it', () => {
  // The control, and the structural half of the fix: OrganizationList — not CompanyPanel — owns the <li>,
  // because it is the only side of the boundary that can still address a row once Flight has deferred it.
  it('owns the <li> and draws all 8 rows when every node was inlined in the payload', () => {
    const html = render(items((name) => inlineNode(name)));
    for (const name of NAMES) expect(html, name).toContain(name);
    expect(html.match(/<li/g) ?? []).toHaveLength(NAMES.length);
  });

  it('draws all 8 rows when EVERY node arrived as a deferred Flight lazy', () => {
    const html = render(items((name) => deferredNode(inlineNode(name))));
    for (const name of NAMES) expect(html, name).toContain(name);
    expect(html.match(/<li/g) ?? []).toHaveLength(NAMES.length);
    // The empty-state row must not appear: the items were there all along.
    expect(html).not.toContain('noMatches');
  });

  it('draws all 8 rows in the PRODUCTION shape — first node inlined, the rest deferred', () => {
    // This is what the reporter's screenshot was: one row of markup for eight companies.
    const html = render(items((name, i) => (i === 0 ? inlineNode(name) : deferredNode(inlineNode(name)))));
    expect(html.match(/<li/g) ?? []).toHaveLength(NAMES.length);
    for (const name of NAMES) expect(html, name).toContain(name);
  });

  it('search still hides non-matching rows without unmounting them', () => {
    // Rendered without a query, every row is visible and none carries the hidden class.
    const html = render(items((name, i) => (i % 2 === 0 ? inlineNode(name) : deferredNode(inlineNode(name)))));
    expect(html).not.toContain('class="hidden"');
    // The panels stay in the markup regardless, which is the mounted-through-search contract.
    for (const name of NAMES) expect(html, name).toContain(name);
  });
});
