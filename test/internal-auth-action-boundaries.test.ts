import { readFileSync } from 'node:fs';
import { createSourceFile, isExpressionStatement, isStringLiteral, ScriptTarget } from 'typescript';
import { expect, it } from 'vitest';
it('keeps every changed action implementation behind a compiler-recognized server directive', () => {
  for (const filename of ['app/auth-actions.ts','app/(auth)/invite/[token]/activate/actions.ts','app/(app)/admin/users/manual-actions.ts','app/(app)/admin/settings/email/actions.ts']) {
    const file = createSourceFile(filename, readFileSync(filename,'utf8'), ScriptTarget.Latest, true), directives: string[] = [];
    for (const statement of file.statements) {
      if (!isExpressionStatement(statement) || !isStringLiteral(statement.expression)) break;
      directives.push(statement.expression.text);
    }
    expect(directives, filename).toContain('use server');
  }
});
