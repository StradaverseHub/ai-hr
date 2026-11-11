import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const { JSDOM }: { JSDOM: new (html: string) => { window: { document: Document; close(): void } } } =
  createRequire(import.meta.url)('jsdom');
const driver = new URL('../scripts/performance/native-next-boot-browser.mjs', import.meta.url);
const source = ts.createSourceFile(driver.pathname, readFileSync(driver, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

// Exercise just the named proof functions from the shipped driver. Importing the
// CLI would launch its private browser protocol. No browser or DB runs here.
function sourceFunction<T>(name: string, context: Record<string, unknown> = {}): T {
  const declarations = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  expect(declarations).toHaveLength(1);
  return runInNewContext(`(${declarations[0].getText(source)})`, { assert, ...context }, {
    contextCodeGeneration: { strings: false, wasm: false },
  }) as T;
}

type Progress = {
  enter(stage: string): void;
  status(status: number | null): void;
  complete(): void;
  fail(type: string): void;
};
const makeProgress = sourceFunction<(emit: (row: Record<string, unknown>) => void) => Progress>('makeFirstHomeProgress');
const stages = [
  'home-navigate', 'account-visible', 'account-identity', 'first-card-visible', 'card-count', 'loading-settled', 'card-keys',
  'today-visible', 'today-content', 'headcount', 'tenant-scope', 'welcome-visible', 'welcome-action', 'welcome-hidden',
  'account-open', 'menu-visible', 'account-close', 'worker-match',
];

it('persists a closed first Home frontier even when the next awaited operation never returns', () => {
  const rows: Record<string, unknown>[] = [];
  const progress = makeProgress(row => rows.push(row));
  expect(() => progress.enter('account-visible')).toThrow();
  progress.enter('home-navigate');
  progress.status(200);
  expect(() => progress.status(201)).toThrow();
  progress.enter('account-visible');
  expect(rows).toEqual([
    { stage: 'home-navigate', state: 'entered' },
    { stage: 'home-navigate', state: 'http-status', status: 200 },
    { stage: 'account-visible', state: 'entered' },
  ]);
  expect(() => progress.fail('fictional private diagnostic text')).toThrow();
  progress.fail('timeout');
  progress.fail('other');
  expect(rows.slice(3)).toEqual([{ stage: 'account-visible', state: 'refused', type: 'timeout' }]);
  expect(() => progress.enter('account-identity')).toThrow();
});

it('records the exact finite success sequence without accepting status in a non-HTTP stage', () => {
  const rows: Record<string, unknown>[] = [];
  const progress = makeProgress(row => rows.push(row));
  expect(() => progress.complete()).toThrow();
  for (const stage of stages) {
    progress.enter(stage);
    if (stage === 'home-navigate' || stage === 'welcome-action') progress.status(200);
    else expect(() => progress.status(200)).toThrow();
  }
  progress.complete();
  progress.fail('other');
  expect(rows.filter(row => row.state === 'entered').map(row => row.stage)).toEqual(stages);
  expect(rows.at(-1)).toEqual({ stage: 'worker-match', state: 'returned' });
  expect(rows).toHaveLength(21);
  expect(Buffer.byteLength(rows.map(row => JSON.stringify(row)).join('\n'))).toBeLessThan(4096);
});

const base = 'https://localhost:3443';
function actionRequest(origin: string, path: string, method: string, action: boolean, status: number | null, seen: string[]) {
  return {
    url: () => origin + path,
    method: () => method,
    headers: () => action ? { 'next-action': 'fictional-private-action-id' } : {},
    existingResponse: () => {
      expect(seen.at(-1)).toBe('request-finished');
      seen.push('cached-response');
      return status === null ? null : { status: () => status, headers: () => ({ 'content-type': 'text/x-component' }) };
    },
  };
}
type FakeRequest = ReturnType<typeof actionRequest>;

async function runSkip(status: number | null) {
  const seen: string[] = [];
  const trace: (string | number | null)[] = [];
  const tour = {
    getByRole(role: string, options: object) {
      expect([role, options]).toEqual(['button', { name: 'Skip', exact: true }]);
      return {
        async waitFor(input: object) {
          expect(input).toEqual({ state: 'visible', timeout: 90000 });
          seen.push('skip-visible');
        },
        async click(input: object) {
          expect(input).toEqual({ timeout: 90000 });
          expect(seen).toEqual(['skip-visible', 'completion-listener']);
          seen.push('click');
        },
      };
    },
    async waitFor(input: object) {
      expect(input).toEqual({ state: 'hidden', timeout: 90000 });
      seen.push('tour-hidden');
    },
  };
  const page = {
    waitForEvent(event: string, { predicate, timeout }: { predicate: (request: FakeRequest) => boolean; timeout: number }) {
      expect([event, timeout]).toEqual(['requestfinished', 90000]);
      seen.push('completion-listener');
      return Promise.resolve().then(() => {
        expect(seen).toEqual(['skip-visible', 'completion-listener', 'click']);
        expect(predicate(actionRequest('https://foreign.invalid', '/', 'POST', true, 200, seen))).toBe(false);
        expect(predicate(actionRequest(base, '/other', 'POST', true, 200, seen))).toBe(false);
        expect(predicate(actionRequest(base, '/', 'GET', true, 200, seen))).toBe(false);
        expect(predicate(actionRequest(base, '/', 'POST', false, 200, seen))).toBe(false);
        const result = actionRequest(base, '/', 'POST', true, status, seen);
        expect(predicate(result)).toBe(true);
        seen.push('request-finished');
        return result;
      });
    },
  };
  const skip = sourceFunction<(page: object, progress: Pick<Progress, 'enter' | 'status'>) => Promise<void>>(
    'skipWelcomeTour', { base, remaining: () => 90000, productTour: () => tour, URL },
  );
  const result = skip(page, { enter: value => trace.push(value), status: value => trace.push(value) });
  return { seen, trace, result };
}

it('binds the actual Skip owner to the matching same-origin Next action before the ordinary click', async () => {
  const { result, seen, trace } = await runSkip(200);
  await expect(result).resolves.toBeUndefined();
  expect(seen).toEqual(['skip-visible', 'completion-listener', 'click', 'request-finished', 'cached-response', 'tour-hidden']);
  expect(trace).toEqual(['welcome-visible', 'welcome-action', 200, 'welcome-hidden']);
});

it('refuses a matching failed server action without claiming the tour is dismissed', async () => {
  for (const status of [500, null]) {
    const { result, seen, trace } = await runSkip(status);
    await expect(result).rejects.toMatchObject({ code: 'ERR_ASSERTION' });
    expect(seen).toEqual(['skip-visible', 'completion-listener', 'click', 'request-finished', 'cached-response']);
    expect(trace).toEqual(['welcome-visible', 'welcome-action', status]);
  }
});


it('refuses closed failure markers on main and inside it without rejecting a normal loading skeleton', async () => {
  const guard = sourceFunction<(page: object) => Promise<void>>('assertNoHomeFailureMarkers');
  const dom = new JSDOM('<aside data-page-busy></aside><main aria-busy="true"><section aria-busy="true"></section></main>');
  try {
    const { document } = dom.window;
    const page = { locator: (selector: string) => ({ count: async () => document.querySelectorAll(selector).length }) };
    await expect(guard(page)).resolves.toBeUndefined();
    for (const target of document.querySelectorAll('main, main section')) {
      for (const marker of ['data-page-busy', 'data-personnel-busy', 'data-read-unavailable', 'data-today-unavailable']) {
        target.setAttribute(marker, '');
        await expect(guard(page)).rejects.toMatchObject({ code: 'ERR_ASSERTION' });
        target.removeAttribute(marker);
      }
    }
    await expect(guard(page)).resolves.toBeUndefined();
  } finally {
    dom.window.close();
  }
});
