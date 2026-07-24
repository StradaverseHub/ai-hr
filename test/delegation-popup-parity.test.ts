/**
 * Delegation popup ↔ full-page parity (feedback 29fe2d45) — the command-bar quick popup and the
 * /delegations page must render the SAME building block (DelegationManager), so fields, validation and
 * capabilities can never drift apart. Source-static guards (precedent: test/personnel-attendance-tab.test.ts):
 *   (a) both surfaces render DelegationManager;
 *   (b) app/delegations/actions.ts no longer imports redirect from next/navigation — the uniform
 *       { ok } / { ok: false, error } returns cannot silently regress to a NEXT_REDIRECT that hard-navigates
 *       the popup away;
 *   (c) loadDelegationContextAction derives admin from the session (isAdmin) and accepts NO admin flag in
 *       its parameters — the admin branch exposes tenant-wide rows + the employment picker, so a
 *       client-supplied flag would be a privilege hole;
 *   (d) delegations.saved exists in all six locales (the inline save confirmation both surfaces render);
 *   (e) the shared manager composes the full-page building blocks — DelegationCreateForm and
 *       DelegationOrgScopePicker — proving the coverage cascade reaches both surfaces;
 *   (f) the popup geometry that makes the shared table usable: Dialog.Content owns the height and is the
 *       SINGLE scroller, and it widens conditionally for the delegation state (the table has a 720px floor).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

const PAGE = read('../app/delegations/page.tsx');
const ACTIONS = read('../app/delegations/actions.ts');
const COMMAND_BAR = read('../components/command-bar.tsx');
const MANAGER = read('../components/delegation-manager.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Delegation popup ↔ page parity (29fe2d45)', () => {
  it('renders the shared DelegationManager on BOTH surfaces', () => {
    expect(PAGE.includes('<DelegationManager')).toBe(true);
    expect(COMMAND_BAR.includes('<DelegationManager')).toBe(true);
    // The popup passes its surface, the page passes its own — same component, different workspace size.
    expect(COMMAND_BAR.includes('surface="popup"')).toBe(true);
    expect(PAGE.includes('surface="page"')).toBe(true);
  });

  it('actions return uniform results — no next/navigation redirect left to bounce the popup', () => {
    expect(/from\s+['"]next\/navigation['"]/.test(ACTIONS)).toBe(false);
    expect(/\bredirect\s*\(/.test(ACTIONS)).toBe(false);
  });

  it('loadDelegationContextAction takes no admin flag and derives admin via isAdmin(session)', () => {
    const start = ACTIONS.indexOf('export async function loadDelegationContextAction');
    expect(start).toBeGreaterThan(-1);
    // Parameter list: everything between the function name and the opening body brace.
    const header = ACTIONS.slice(start, ACTIONS.indexOf('{', start));
    expect(/admin/i.test(header.slice(header.indexOf('(')))).toBe(false);
    // Body (up to the next top-level export): must derive the role from the session.
    const nextExport = ACTIONS.indexOf('\nexport ', start + 1);
    const body = ACTIONS.slice(start, nextExport === -1 ? undefined : nextExport);
    expect(body.includes('isAdmin(')).toBe(true);
  });

  it('has delegations.saved in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(read(`../messages/${loc}.json`));
      const label = msg?.delegations?.saved;
      expect(typeof label, `messages/${loc}.json missing delegations.saved`).toBe('string');
      expect(label.length, `messages/${loc}.json delegations.saved is empty`).toBeGreaterThan(0);
    }
  });

  it('composes the full-page building blocks in the shared manager (coverage cascade included)', () => {
    expect(MANAGER.includes('DelegationCreateForm')).toBe(true);
    expect(MANAGER.includes('DelegationOrgScopePicker')).toBe(true);
  });

  it('popup geometry: Dialog.Content is the single scroller and widens only for the delegation state', () => {
    // Assert on the OPENING TAG slice only (same technique as test/header-command-bar.test.ts) so a comment
    // can neither satisfy nor break these — the className is a template literal, it contains no '>'.
    const openTagStart = COMMAND_BAR.indexOf('<Dialog.Content');
    expect(openTagStart, 'components/command-bar.tsx must render a Dialog.Content').toBeGreaterThan(-1);
    const content = COMMAND_BAR.slice(openTagStart, COMMAND_BAR.indexOf('>', openTagStart));

    // Content owns the height AND does the scrolling — inner vh-sized boxes clipped the table with no
    // scrollbar to recover it, because they measure against the viewport, not against Content's box.
    expect(content).toContain('max-h-[76vh]');
    expect(content).toContain('overflow-y-auto');

    // Conditional width: an unconditional max-w-4xl would blow up the compact search list.
    expect(content).toContain("active === 'delegation' ? 'max-w-4xl' : 'max-w-lg'");

    // The pair is what makes the width meaningful: 896px Content minus the padding chain
    // (quick-panel p-4 + Card border + list wrapper p-4 = 68px) = 828px for the table's 720px floor.
    // KNOWN GAP: this guard is source-static and cannot prove fit — raising the floor to, say,
    // min-w-[900px] would clip the Edit/Revoke cell again with this test still green.
    expect(MANAGER).toContain('min-w-[720px]');

    // No second height box anywhere in the file — exactly one vh-based max-h, the one on Content.
    expect(COMMAND_BAR.match(/max-h-\[\d+(?:\.\d+)?vh\]/g) ?? []).toHaveLength(1);
  });
});
