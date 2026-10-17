import ts from 'typescript';
import { personnelControl } from '../../lib/personnel-form-contract';
/** Follow a literal descriptor on an actual JSX spread, then verify its posted action name.
 * Dynamic widget branches still need their caller's explicit form-mode assertion. A caption/reference
 * alone cannot satisfy this guard, and a draft-only binding cannot pass as a named form control. */
export function hasPersonnelPostedBinding(source: string, id: string, name: string): boolean {
  const file = ts.createSourceFile('form.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let mounted = false;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSpreadAttribute(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const adapter = call.expression.getText(file);
      const identity = call.arguments[0];
      const mode = call.arguments[1];
      const identities = (value: ts.Expression): string[] => ts.isStringLiteralLike(value) ? [value.text]
        : ts.isConditionalExpression(value) ? [...identities(value.whenTrue), ...identities(value.whenFalse)] : [];
      if (['personnelInput', 'personnelControl', 'personnelCarry', 'personnelRadio'].includes(adapter)
        && identity && identities(identity).includes(id)
        && !(mode && ts.isStringLiteralLike(mode) && mode.text === 'draft')) mounted = true;
    }
    node.forEachChild(visit);
  };
  visit(file);
  return mounted && personnelControl(id).name === name;
}
