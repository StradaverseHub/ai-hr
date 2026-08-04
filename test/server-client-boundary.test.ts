/**
 * A SERVER component may pass a client component only SERIALISABLE props.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE r123 SHIPPED A BROKEN PAGE TO PRODUCTION AND NOTHING IN THE GATE SAW IT.
 *
 * 10e96227 dropped `ChipMultiSelect` (a 'use client' component) into
 * app/admin/leave/entitlements/page.tsx (a server component) and passed it two closures over the server's
 * translator, `removeLabelFor` and `countLabelFor`. React cannot serialise a function across the boundary,
 * so it threw at RENDER time and the whole Entitlements tab returned "This page couldn't load". The
 * reporter raised it as b55fdf33.
 *
 * WHY EVERY EXISTING GATE STEP MISSED IT, which is the part worth internalising:
 *   - `tsc --noEmit` is happy: a function prop is perfectly well-typed.
 *   - `next build` is happy: this is a RUNTIME serialisation error, not a build error.
 *   - the suite is happy: this repo's component tests are static source scans and core-behaviour tests
 *     against the database. Nothing rendered the page.
 *   - the idiom LOOKED safe because every other ChipMultiSelect caller lives inside
 *     components/leave-type-panel.tsx, which is itself a client component — where function props are legal.
 *
 * So the defect is invisible to types, invisible to the build, and invisible to every test that does not
 * actually render. A static scan is the cheapest thing that can see it, and that is what this is.
 *
 * WHAT IT CHECKS: for each server component under app/ (no 'use client' at the top), find JSX elements
 * whose tag is a known client component and flag any prop whose value is an arrow function or a function
 * expression. That is exactly the shape React refuses.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

const isClientFile = (src: string) => /^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400));

/** Every component file that declares 'use client', by exported component name. */
function clientComponentNames(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of ['components', 'app']) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      if (!isClientFile(src)) continue;
      for (const m of src.matchAll(/export\s+(?:default\s+)?function\s+([A-Z]\w*)/g)) {
        byName.set(m[1], relative(ROOT, file));
      }
      for (const m of src.matchAll(/export\s+const\s+([A-Z]\w*)\s*[:=]/g)) {
        byName.set(m[1], relative(ROOT, file));
      }
    }
  }
  return byName;
}

/**
 * Function-valued JSX props on `<Tag ...>`, scanned crudely but conservatively: we only look at the
 * attribute region between the tag name and the first `>` at depth zero, and only flag `prop={(…) =>` or
 * `prop={function`. Event handlers (onX) are excluded — a server component cannot legally use them either,
 * but they are a different, louder mistake and this file is about the quiet one.
 */
function functionPropsOn(src: string, tag: string): { prop: string; line: number }[] {
  const found: { prop: string; line: number }[] = [];
  const re = new RegExp(`<${tag}(\\s)`, 'g');
  for (const m of src.matchAll(re)) {
    const start = m.index!;
    let i = start;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const attrs = src.slice(start, i);
    for (const p of attrs.matchAll(/(\w+)=\{\s*(?:\([^)]*\)|\w+)\s*=>/g)) {
      if (!/^on[A-Z]/.test(p[1])) found.push({ prop: p[1], line: src.slice(0, start).split('\n').length });
    }
    for (const p of attrs.matchAll(/(\w+)=\{\s*function\b/g)) {
      if (!/^on[A-Z]/.test(p[1])) found.push({ prop: p[1], line: src.slice(0, start).split('\n').length });
    }
    // 7f6ca478 — A FUNCTION ONE LEVEL DOWN IS STILL A FUNCTION, and the two scans above only see one at
    // the TOP of an attribute value. `labels={{ runsInMonth: (n) => t(…) }}` slipped straight through:
    // tsc was clean, the suite was green, and every request to /payroll returned 500 with "Functions
    // cannot be passed directly to Client Components". Found by rendering, which is the only reason we
    // know this hole existed.
    //
    // Scoped deliberately to OBJECT-LITERAL props (`name={{ … }}`) — the shape that actually broke.
    // Not widened to every brace: a prop holding a JSX element (`header={<Foo onClick={…} />}`) may
    // legitimately carry a handler bound inside another client component, and flagging those would make
    // this guard cry wolf. A guard with a known, documented edge beats one nobody trusts.
    for (const p of attrs.matchAll(/(\w+)=\{\{/g)) {
      if (/^on[A-Z]/.test(p[1])) continue;
      let j = p.index! + p[0].length - 1; // sit on the inner '{'
      let d = 0;
      for (; j < attrs.length; j++) {
        if (attrs[j] === '{') d++;
        else if (attrs[j] === '}') { d--; if (d === 0) break; }
      }
      const body = attrs.slice(p.index! + p[0].length, j);
      // A PROPERTY WHOSE VALUE IS A FUNCTION — `key: (a) => …` or `key: function`. Deliberately NOT a
      // bare search for `=>`: `items: xs.map((x) => f(x))` contains an arrow that is CALLED during
      // render and yields plain data, which is perfectly serializable. Measured — the loose version
      // flagged four such sites already in the tree (payroll-policy, personnel, import, analytics),
      // and a guard that reports four false alarms on day one is one nobody will trust on day two.
      // The params group forbids nested parens, which is what separates a function VALUE from an
      // IIFE: `allowedKinds: (() => {…})()` yields data and is fine, `runsInMonth: (n) => …` does not.
      if (/(?:^|[{,\s])\w+\s*:\s*(?:\([^()]*\)|\w+)\s*=>/.test(body) || /(?:^|[{,\s])\w+\s*:\s*function\s*\(/.test(body)) {
        found.push({ prop: p[1], line: src.slice(0, start).split('\n').length });
      }
    }
  }
  return found;
}

describe('b55fdf33 · a server component may not pass functions to a client component', () => {
  it('no server file under app/ passes a function prop to a known client component', () => {
    const clients = clientComponentNames();
    expect(clients.size, 'client components discovered').toBeGreaterThan(5);

    const offences: string[] = [];
    for (const file of walk(join(ROOT, 'app'))) {
      const src = readFileSync(file, 'utf8');
      if (isClientFile(src)) continue; // a client caller may pass functions freely
      for (const [name, defFile] of clients) {
        if (!new RegExp(`<${name}(\\s|/|>)`).test(src)) continue;
        for (const hit of functionPropsOn(src, name)) {
          offences.push(`${relative(ROOT, file)}:${hit.line} passes ${hit.prop}={…} to <${name}> (${defFile})`);
        }
      }
    }
    expect(offences, `server→client function props:\n${offences.join('\n')}`).toEqual([]);
  });

  it('the Entitlements page reaches ChipMultiSelect through the client wrapper, not directly', () => {
    // The specific regression. Kept alongside the general rule because the general scan is heuristic and
    // this one is exact — if the scan is ever weakened, this still fails.
    const page = readFileSync(join(ROOT, 'app/admin/leave/entitlements/page.tsx'), 'utf8');
    expect(page).not.toContain('<ChipMultiSelect');
    expect(page).not.toMatch(/from '@\/components\/ui\/chip-multi-select'/);
    expect(page).toContain('<HalfDayCompanyPicker');

    const wrapper = readFileSync(join(ROOT, 'components/leave/half-day-company-picker.tsx'), 'utf8');
    expect(isClientFile(wrapper), 'the wrapper must be a client component').toBe(true);
    expect(wrapper).toContain('useTranslations');
    expect(wrapper).toContain('<ChipMultiSelect');
  });

  it('the wrapper takes only serialisable props', () => {
    const wrapper = readFileSync(join(ROOT, 'components/leave/half-day-company-picker.tsx'), 'utf8');
    const sig = wrapper.slice(wrapper.indexOf('export function HalfDayCompanyPicker'), wrapper.indexOf(') {'));
    // No function types in the prop signature — that is what makes it safe for a server caller.
    expect(sig).not.toMatch(/=>\s*(string|void|number|boolean)/);
    expect(sig).not.toContain('ReturnType<typeof useTranslations>');
  });
});
