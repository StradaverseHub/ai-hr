/**
 * FilterPanel must never be rendered inside another <form>.
 *
 * The panel renders its OWN `<form method="get">` (components/filter-panel.tsx). Nesting forms is
 * invalid HTML and browsers do not error — the parser silently discards the inner tags. The panel's
 * fields are absorbed into the enclosing form, and its Apply button submits that form instead.
 *
 * Two pages shipped this way in r74 wave 1 (/leave/employee-balances and /leave/employee-records) and
 * appeared to work, because both forms happened to point at the same action. That is coincidence, not
 * design: the moment the two forms disagree — a different action, or the optional `hidden` prop added
 * for the two-listing page, which exists precisely so one listing's submit does not clear the other's —
 * the page starts submitting the wrong field set with no error anywhere.
 *
 * Source-static, because this is a JSX STRUCTURE property. Rendering the page to check would need a
 * full server-component harness with a session and a database, and would still only cover the pages
 * someone remembered to add. Counting unclosed <form> tags before each <FilterPanel> covers every page
 * that exists now and every one added later.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/** Every .tsx under app/ and components/ — the only places JSX lives. */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Strip comments before counting tags.
 *
 * Learned the hard way while writing this guard: app/leave/page.tsx carries a comment that EXPLAINS the
 * rule — "it renders its own <form>, and nesting one inside…" — and a naive scan counted that prose as a
 * real opening tag, reporting a correctly-written page as an offender. A guard that fires on the comment
 * documenting it is worse than no guard, because the next person learns to ignore it.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, incl. the JSX {/* … */} body
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l)) // whole-line // and continuation-* lines
    .join('\n');
}

const CANDIDATES = [path.join(ROOT, 'app'), path.join(ROOT, 'components')]
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => tsxFiles(d));

describe('FilterPanel is never nested inside another form', () => {
  it('finds the pages that use it (guard is not vacuously passing)', () => {
    const users = CANDIDATES.filter((f) => /<FilterPanel(?=[\s/>])/.test(stripComments(fs.readFileSync(f, 'utf8'))));
    expect(users.length, 'at least one page mounts FilterPanel').toBeGreaterThan(0);
  });

  it('no <FilterPanel> sits inside an unclosed <form>', () => {
    const offenders: string[] = [];
    for (const file of CANDIDATES) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      // Walk each mount point and count the forms still open above it. Self-closing `<form />` does not
      // occur in this codebase (a form always wraps children), so open-minus-closed is the nesting depth.
      // The boundary matters: a plain substring search also matches the TYPE `Omit<FilterPanelProps,…>`
      // inside the component's own file, which is not a mount at all. Require what follows the name to
      // end the JSX tag name.
      const MOUNT = /<FilterPanel(?=[\s/>])/g;
      for (let m = MOUNT.exec(src); m !== null; m = MOUNT.exec(src)) {
        const at = m.index;
        const before = src.slice(0, at);
        const depth = (before.match(/<form[\s>]/g) ?? []).length - (before.match(/<\/form>/g) ?? []).length;
        if (depth > 0) offenders.push(`${path.relative(ROOT, file)} (inside ${depth} open <form>)`);
      }
    }
    expect(offenders, `FilterPanel renders its own <form>; these mount it inside another:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });
});
