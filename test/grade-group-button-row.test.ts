/**
 * 6e9a126e RELEASE THREE — REPOINTED, NOT RETIRED. This guards the grade-group delete button's placement,
 * and grade groups SURVIVED the release: 205 leave_approval_policy rows scope by them. What moved is
 * WHERE the editor lives — it was lifted out of the deleted components/benefit-scheme-config.tsx into
 * components/leave/grade-group-config.tsx so it would outlive the workbench. Retiring this because its
 * old source file is gone would have dropped live coverage of a surviving screen.
 */
/**
 * Feedback 9054e31c — Grade Group expand: Save and Delete on one row.
 *
 * Delete used to live in its own sibling <form> on a second row under Save. It is now a second submit
 * button INSIDE the update form's flex row, posting deleteGradeGroup via formAction (the established
 * pattern at app/admin/holidays/page.tsx and components/tp1-declaration-form.tsx). deleteGradeGroupAction
 * reads only fd.get('id') — the update form's extra name/gradeIds fields are ignored — and the button
 * carries formNoValidate so a cleared required name input cannot block the Delete submit.
 *
 * DB-free static-source guard (repo convention, cf. test/company-panel-bank-statutory-layout.test.ts),
 * anchored on the NEW structure. The one functional subtlety this change introduces is formNoValidate:
 * TypeScript cannot catch its removal, and without it Delete silently breaks whenever the name field is
 * cleared — assertion (b) pins it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const panel = readFileSync(root + 'components/leave/grade-group-config.tsx', 'utf8');

describe('Grade Group expand: Save and Delete share one row', () => {
  it('Delete is a formAction submit button inside the update form, not a standalone form', () => {
    expect(panel).toContain('formAction={actions.deleteGradeGroup}');
    expect(panel).not.toContain('<form action={actions.deleteGradeGroup}');
  });

  it('the delete button carries formNoValidate (a cleared name field must not block Delete)', () => {
    const btn = panel.match(/<Button[^>]*formAction=\{actions\.deleteGradeGroup\}[^>]*>/)?.[0] ?? '';
    expect(btn, 'delete Button opening tag must exist').not.toBe('');
    expect(btn).toMatch(/\bformNoValidate\b/);
  });
});
