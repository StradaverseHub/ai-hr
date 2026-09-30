'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import type { EmployeeIdRule } from '@/lib/employee-id-mode';
import {
  CreateEmployeeFields,
  type CreatedEmployee,
  type Option,
} from './new/create-form';

/**
 * Create New Employee — the prompt over the employee list (item 034a5080).
 *
 * WHAT THE REPORTER ASKED FOR, in their words: "the system shall display a Create New Employee
 * prompt/modal instead of navigating the user to a separate full screen", with Cancel and Create
 * Employee, the Employee ID as a proper read-only field, and a confirmation once the record exists.
 * Item 6d671f44 had moved creation OFF the list and onto its own route precisely because that reporter
 * wrote "The current employee list screen shall not be used for data entry" — this item walks that back
 * for the four-question create only, and the route it walked away from is deliberately KEPT (see below).
 *
 * THE BODY IS NOT A COPY. It is `CreateEmployeeFields` from app/admin/personnel/new/create-form.tsx —
 * the same component the standalone route renders, so the Employee ID block (mode decision, duplicate
 * look-ahead, "company changed, drop the typed code") has exactly one implementation. This file adds two
 * things and nothing else: the Radix shell, and the confirmation step.
 *
 * THE TRIGGER IS STILL A LINK, and that is on purpose. `href="/admin/personnel/new"` means ⌘-click and
 * middle-click still open the full screen in a new tab, and a browser with no JS still gets there — the
 * route remains the non-JS path, the onboarding tour's anchor (`data-tour="people-hire"`, which moved
 * here from the list page with the button it belongs to), and the target of every draft row's ?draft=
 * link. A plain left click is intercepted and opens the prompt instead. Modified clicks are let through
 * untouched, which is why the handler tests the modifiers before calling preventDefault.
 *
 * THE CONFIRMATION NAMES THE ID THE SERVER ISSUED, never the previewed one. `rule.sampleCode` — the
 * number the read-only field shows — is `nextRunningNumber` read when the page was rendered, and
 * lib/employee-id-mode.ts calls it "A preview, not a reservation". The counter is advanced inside the
 * create transaction (`issueEmployeeCode`, which additionally skips numbers already claimed), so two
 * administrators who opened this prompt at the same moment are shown the same preview and are issued
 * different numbers. `createDraftAction` returns the issued code; this screen shows THAT. It is the only
 * place in the flow where the difference is visible to a human, which is the reason the confirmation is
 * worth its two clicks.
 *
 * Dialog.Portal reparents Content to document.body, so nothing inside the prompt is inside the list's
 * DOM — there is no capture-phase submit listener on this screen to escape (components/personnel-tabs.tsx
 * documents the equivalent trap on the record screen, feedback bd2f0bb2), and the body posts through a
 * server action rather than a form submit in any case.
 */
export function CreateEmployeeDialog({
  triggerLabel,
  companies,
  employeeIdRules,
}: {
  /** `people.list.createNewEmployee`, resolved by the server page. Passed as PLAIN DATA rather than read
   *  here so this file stays on ONE message namespace (test/i18n-coverage.test.ts check C skips a file
   *  that mixes two, which would silently stop checking every key below). */
  triggerLabel: string;
  companies: Option[];
  employeeIdRules: Record<string, EmployeeIdRule>;
}) {
  const t = useTranslations('people.wizard');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedEmployee | null>(null);

  /** Closing discards the confirmation too, so re-opening starts a fresh create rather than reopening
   *  the receipt of the last one. */
  const change = (next: boolean) => {
    setOpen(next);
    if (!next) setCreated(null);
  };

  const backToList = () => {
    change(false);
    // The action already revalidated /admin/personnel; this is what makes the new Draft row appear
    // without the reporter having to reload the screen they never left.
    router.refresh();
  };

  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Link
        href="/admin/personnel/new"
        data-tour="people-hire"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        onClick={(e) => {
          // Let the browser have ⌘/ctrl/shift/alt-click and any non-primary button: those mean "open the
          // full screen", and a modal cannot honour them.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          change(true);
        }}
      >
        {triggerLabel}
      </Link>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">
              {created ? t('created.heading') : t('title')}
            </Dialog.Title>
            <Dialog.Close asChild>
              {/* "Close", NOT "Cancel". The footer already has a Cancel button (requirement 9), and two
                  controls with the same accessible name is a screen reader reading the same word twice for
                  two different affordances — and a test that cannot tell them apart. */}
              <Button type="button" variant="ghost" size="sm" aria-label={t('close')}>
                ✕
              </Button>
            </Dialog.Close>
          </div>

          <div className="mt-4">
            {created ? (
              <div className="space-y-5" data-created-employee>
                <p className="text-sm text-muted-foreground">{t('created.body')}</p>
                <dl className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">{t('fields.fullName')}</dt>
                    <dd className="text-sm font-medium">{created.fullName}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">{t('fields.company')}</dt>
                    <dd className="text-sm font-medium">{created.companyLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">{t('employeeId.heading')}</dt>
                    {/* THE ISSUED ID, from the server's answer. Marked so a render check and the dom test
                        can tell it apart from the preview field inside the form body. */}
                    <dd className="font-mono text-lg font-semibold" data-issued-employee-id>
                      {created.employeeCode}
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={() => router.push(`/admin/personnel/new?draft=${created.id}`)}
                  >
                    {t('created.continue')}
                  </Button>
                  <Button type="button" variant="outline" onClick={backToList}>
                    {t('created.backToList')}
                  </Button>
                </div>
              </div>
            ) : (
              <CreateEmployeeFields
                companies={companies}
                employeeIdRules={employeeIdRules}
                framed={false}
                onCreated={setCreated}
                onCancel={() => change(false)}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
