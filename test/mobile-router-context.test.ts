import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** SDK58 keeps each mounted navigation store in context. Its process-global router can
 * lose that store after the authenticated Stack unmounts for the normal session lock. */
it('mobile routes and lifecycle observers never capture the process-global Expo router', () => {
  const files: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.tsx?$/.test(file)) files.push(file);
    }
  }
  visit('mobile/app'); visit('mobile/lib');
  expect(files.length).toBeGreaterThan(50);
  const offenders: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'expo-router') continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.some(item => (item.propertyName ?? item.name).text === 'router')) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
