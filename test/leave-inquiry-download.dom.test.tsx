import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { ReactElement } from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ts from 'typescript';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { inquirySearchParams, parseInquiryQuery } from '../lib/leave-inquiry-query';

afterEach(cleanup);

/**
 * Render the shipped export JSX and URL builder, without importing either server page's DB graph.
 * These are file downloads: a native anchor leaves the request to the browser, including its session
 * cookies. Next Link without download intercepts the click as app navigation instead. This contract
 * detects that regression; jsdom cannot prove a saved file or diagnose a Chrome download refusal.
 */
function exportActions(page: 'employee-balances' | 'employee-records', selection: string) {
  const path = resolve(process.cwd(), 'app', '(app)', 'leave', page, 'page.tsx');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const actions: ts.JsxElement[] = [];
  const declarations = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node]);
    }
    if (ts.isJsxElement(node)) {
      const href = node.openingElement.attributes.properties.find(
        (prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'href',
      );
      if (href?.initializer && ts.isJsxExpression(href.initializer)) {
        const value = href.initializer.expression;
        if (value && ts.isCallExpression(value) && value.expression.getText(source) === 'exportHref') actions.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(actions, `${page} must expose both export actions`).toHaveLength(2);
  for (const action of actions) {
    expect(action.openingElement.tagName.getText(source), `${page}: export bypasses SPA routing`).toBe('a');
    const props = action.openingElement.attributes.properties;
    expect(props.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'download')).toBe(true);
    expect(props.some(prop => ts.isJsxSpreadAttribute(prop) || (ts.isJsxAttribute(prop) && /^on[A-Z]/.test(prop.name.getText(source))))).toBe(false);
  }
  const declaration = (name: string) => {
    const matches = declarations.get(name) ?? [];
    expect(matches, `${page} retains one ${name} URL builder`).toHaveLength(1);
    return `const ${matches[0].getText(source)};`;
  };
  const program = [
    declaration('exportHref'),
    ...(page === 'employee-records' ? [declaration('withSort')] : []),
    `module.exports.view = <>${actions.map(action => action.getText(source)).join('\n')}</>;`,
  ].join('\n');
  const output = { exports: {} as { view: ReactElement } };
  runInNewContext(ts.transpileModule(program, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module: output,
    exports: output.exports,
    params: () => new URLSearchParams(selection),
    sort: 'employeeCode',
    dir: 'desc',
    t: (key: string) => key,
    require: (name: string) => {
      if (name === 'react/jsx-runtime') return jsx;
      throw new Error(`Unexpected export action dependency: ${name}`);
    },
  });
  return output.exports.view;
}

describe.each(['employee-balances', 'employee-records'] as const)('%s browser download actions', page => {
  it.each([
    { label: 'All', employment: undefined },
    { label: 'selected employee', employment: '10000000-0000-4000-8000-000000000001' },
  ])('preserves $label selection and repeated filters for CSV and Excel', ({ employment }) => {
    const filters = new URLSearchParams([
      ['q', 'Annual & medical'],
      ['type', '20000000-0000-4000-8000-000000000001'], ['type', '20000000-0000-4000-8000-000000000002'],
      ['status', 'approved'], ['status', 'pending'],
      ['department', '30000000-0000-4000-8000-000000000001'], ['department', '30000000-0000-4000-8000-000000000002'],
      ['from', '2020-01-01'], ['to', '2020-01-31'], ['asOf', '2020-01-31'],
      ['sort', 'employeeCode'], ['dir', 'desc'], ['size', 'all'],
    ]);
    if (employment) filters.set('emp', employment);
    expect(parseInquiryQuery(inquirySearchParams(filters), page === 'employee-balances' ? 'balances' : 'records').emp).toBe(employment);
    render(exportActions(page, filters.toString()));
    for (const [caption, format] of [['filters.exportCsv', 'csv'], ['filters.exportExcel', 'xlsx']]) {
      const anchor = screen.getByRole('link', { name: caption });
      expect(anchor.tagName).toBe('A');
      expect(anchor).toHaveAttribute('download');
      expect(anchor).not.toHaveAttribute('target');
      const href = new URL(anchor.getAttribute('href')!, 'https://hr.example.test');
      expect(href.origin).toBe('https://hr.example.test');
      expect(href.pathname).toBe(`/leave/${page}/export`);
      const expected = new URLSearchParams(filters);
      expected.set('format', format);
      expect([...href.searchParams]).toEqual([...expected]);
    }
  });
});
