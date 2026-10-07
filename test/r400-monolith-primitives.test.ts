/**
 * r400 — Monolith rollout STEP 3, the primitives (docs/design/monolith/README.md §4, §7 step 3: "Keep APIs;
 * change rendering"). THE CLASSIC GUARD.
 *
 * Button, Input, Badge and Card are shared by ~every screen, and Classic must stay pixel-identical. The only
 * permitted change to these four files is APPENDING `monolith:`-scoped utilities (which do not match at all
 * unless <html data-ui-theme="monolith">). Two independent proofs, the r398 pattern plus a stronger one:
 *
 *  1. SOURCE. Every class literal in main's copy of each file is still in this branch's copy, verbatim and
 *     still a whole quoted string — so nothing was edited inside a Classic string.
 *  2. OUTPUT. main's copy of each file is materialised beside this one and BOTH are evaluated, for every
 *     variant × size (and with a caller's className): this branch's class list with its `monolith:` tokens
 *     removed must equal main's class list EXACTLY, token for token and in order. That also catches what (1)
 *     cannot: tailwind-merge silently DROPPING a Classic class because an appended one conflicted with it.
 *
 * Non-vacuity is asserted at each step: main's file has class literals, the sweep compared real combinations,
 * and the branch really does add Monolith tokens (a guard that compared two Classic-only outputs would pass
 * on a revert of the whole feature, and say nothing about the feature).
 *
 * The rendered half (each component under data-ui-theme=monolith vs classic, and the new primitives) is in
 * test/r400-monolith-primitives.dom.test.tsx.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const onMain = (p: string) => execFileSync('git', ['show', `main:${p}`], { cwd: ROOT, encoding: 'utf8' });
const FILES = ['components/ui/button.tsx', 'components/ui/input.tsx', 'components/ui/badge.tsx', 'components/ui/card.tsx'];

/** Every single-quoted string literal that reads as a Tailwind class list (at least one utility-shaped token). */
const classLiterals = (src: string) =>
  [...src.matchAll(/'([^'\n]+)'/g)]
    .map((m) => m[1])
    .filter((s) => /^[a-z0-9!:[\]().%_/&>*=,#\- ]+$/.test(s) && /(^|\s)(p|px|py|h|text|bg|border|rounded|flex|inline-flex|size)(-|\b)/.test(s));

const isMonolith = (t: string) => t.startsWith('monolith:');
const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);
const classic = (cls: string) => tokens(cls).filter((t) => !isMonolith(t)).join(' ');
const monolithTokens = (cls: string) => tokens(cls).filter(isMonolith);

describe('Classic is untouched (source): main’s class literals are all still here, whole and verbatim', () => {
  for (const file of FILES) {
    it(file, () => {
      const before = classLiterals(onMain(file));
      expect(before.length, `no class literals read from main:${file}`).toBeGreaterThan(0);
      const now = read(file);
      for (const cls of before) expect(now.includes(`'${cls}'`), `Classic class string changed in ${file}: '${cls}'`).toBe(true);
    });
  }
});

// ── 2. OUTPUT ──────────────────────────────────────────────────────────────────────────────────────────────
const require_ = createRequire(path.join(ROOT, 'package.json'));
let tmp = '';
type Mod = Record<string, unknown>;
const main: Record<string, Mod> = {};
const now: Record<string, Mod> = {};

/** main's copy, with its imports pointed at THIS checkout's modules, so the two differ only in the file. */
function materialiseMain(file: string): string {
  let src = onMain(file);
  src = src.replace(/from '@\/lib\/utils'/g, `from ${JSON.stringify(path.join(ROOT, 'lib/utils.ts'))}`);
  for (const dep of ['react', 'class-variance-authority', '@radix-ui/react-slot']) {
    src = src.split(`from '${dep}'`).join(`from ${JSON.stringify(require_.resolve(dep))}`);
  }
  const out = path.join(tmp, path.basename(file));
  fs.writeFileSync(out, src);
  return out;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r400-main-ui-'));
  for (const file of FILES) {
    const key = path.basename(file, '.tsx');
    main[key] = (await import(/* @vite-ignore */ materialiseMain(file))) as Mod;
  }
  now.button = (await import('../components/ui/button')) as Mod;
  now.input = (await import('../components/ui/input')) as Mod;
  now.badge = (await import('../components/ui/badge')) as Mod;
  now.card = (await import('../components/ui/card')) as Mod;
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** The class attribute of the first element a component renders. */
const classOf = (C: unknown, props: Record<string, unknown>) => {
  const html = renderToStaticMarkup(React.createElement(C as React.FC, props));
  const m = html.match(/class="([^"]*)"/);
  expect(m, `no class attribute in ${html}`).not.toBeNull();
  return m![1];
};

const CALLER = { none: undefined, layout: 'w-full mt-2', override: 'h-8 px-2 bg-emerald-600' } as const;

describe('Classic is untouched (output): this branch minus its monolith: tokens === main, exactly', () => {
  it('buttonVariants, every variant × size × caller className', () => {
    const variants = [undefined, 'default', 'destructive', 'outline', 'secondary', 'ghost', 'link'];
    const sizes = [undefined, 'default', 'sm', 'lg', 'icon'];
    let compared = 0;
    let added = 0;
    for (const variant of variants)
      for (const size of sizes)
        for (const className of Object.values(CALLER)) {
          const args = { variant, size, className };
          const was = (main.button.buttonVariants as (a: unknown) => string)(args);
          const is = (now.button.buttonVariants as (a: unknown) => string)(args);
          expect(classic(is), `button ${JSON.stringify(args)}`).toBe(was);
          compared++;
          added += monolithTokens(is).length;
        }
    expect(compared).toBe(7 * 5 * 3);
    expect(added).toBeGreaterThan(compared * 5);
  });

  it('<Button> renders main’s classes (cn() on top of cva)', () => {
    for (const variant of ['default', 'outline', 'ghost', 'link'])
      for (const className of Object.values(CALLER)) {
        const props = { variant, className, children: 'Go' };
        expect(classic(classOf(now.button.Button, props))).toBe(classOf(main.button.Button, props));
      }
  });

  it('badgeVariants and <Badge>, every variant × caller className', () => {
    let compared = 0;
    for (const variant of [undefined, 'default', 'success', 'warning', 'danger', 'info', 'accent'])
      for (const className of Object.values(CALLER)) {
        const props = { variant, className, children: 'Pending' };
        const is = classOf(now.badge.Badge, props);
        expect(classic(is), `badge ${variant} ${className}`).toBe(classOf(main.badge.Badge, props));
        expect(monolithTokens(is).length).toBeGreaterThan(5);
        compared++;
      }
    expect(compared).toBe(21);
  });

  it('<Input>, with and without a caller className and type', () => {
    for (const className of Object.values(CALLER))
      for (const type of [undefined, 'text', 'date', 'number']) {
        const props = { className, type };
        const is = classOf(now.input.Input, props);
        expect(classic(is)).toBe(classOf(main.input.Input, props));
        expect(monolithTokens(is)).toContain('monolith:border-b');
      }
  });

  it('<Card>, <CardHeader>, <CardTitle>, <CardContent>', () => {
    for (const part of ['Card', 'CardHeader', 'CardTitle', 'CardContent'])
      for (const className of Object.values(CALLER)) {
        const props = { className, children: 'x' };
        const is = classOf(now.card[part], props);
        expect(classic(is), `${part} ${className}`).toBe(classOf(main.card[part], props));
        expect(monolithTokens(is).length, part).toBeGreaterThan(0);
      }
  });

  it('the public API is unchanged: the same exports, by name', () => {
    for (const key of ['button', 'input', 'badge', 'card']) {
      expect(Object.keys(now[key]).sort(), key).toEqual(Object.keys(main[key]).sort());
    }
  });
});
