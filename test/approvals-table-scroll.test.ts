import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../app/approvals/page.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

describe('approval tables remain reachable inside their cards', () => {
  it('places every approval table directly inside its own horizontal scroll container', () => {
    const tables: ts.JsxElement[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'table') tables.push(node);
      ts.forEachChild(node, walk);
    };
    walk(file);
    // Non-vacuity: the six existing table queues must all be inspected.
    expect(tables).toHaveLength(6);
    for (const table of tables) {
      const wrapper = table.parent;
      expect(ts.isJsxElement(wrapper)).toBe(true);
      if (!ts.isJsxElement(wrapper)) throw new Error('Table has no element scroll container');
      expect(wrapper.openingElement.tagName.getText(file)).toBe('div');
      expect(wrapper.openingElement.attributes.getText(file)).toContain('className="overflow-x-auto"');
      expect(wrapper.openingElement.attributes.getText(file)).toContain('data-approvals-table-scroll');
    }
  });
});
