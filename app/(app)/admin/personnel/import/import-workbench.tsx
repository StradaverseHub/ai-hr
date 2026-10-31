'use client';

import {InformationCorrectionImport} from './information-correction-import';
import {CostAllocationImport} from './cost-allocation-import';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import { PERSONNEL_IMPORT_CHOICES, type PersonnelImportChoice } from '@/lib/import-sections';
import { EmployeeImport, type ImportReference } from './employee-import';
import { SectionImport } from './section-import';
import {MovementImport} from './movement-import';
import {ImportExplanations} from './import-explanations';

/**
 * Item 2983802f — THE FIRST STEP THE REQUEST ASKED FOR: choose what you are importing.
 *
 * Everything below this chooser already existed or is new; the chooser itself is what turns "one very
 * wide spreadsheet" into "a template per subject area". The FIRST choice is
 * the import that works today:
 *
 *   · Everything            — the full 49-column template. Creates new employees. UNCHANGED.
 *   · Profile               ┐
 *   · Movement              │ narrow templates, one section each, that UPDATE people who already exist
 *   · Bank and Statutory    │ and are matched by Employee ID.
 *   · Family                ┘
 *
 * The full template is the default selection, deliberately. The reporter was promised they would never
 * be without a working import while this was built, and an admin who opens this screen out of habit
 * must land on the flow they already know rather than on a new one that cannot create anybody.
 *
 * Switching choices throws away the loaded file and any preview with it — the two importers validate
 * against different column contracts, so carrying a Profile file into the Bank and Statutory flow could
 * only ever produce a confusing refusal. Unmounting the island is what guarantees that.
 */
export function ImportWorkbench({
  companies,
  defaultCompanyId,
  reference,
}: {
  companies: { id: string; name: string }[];
  defaultCompanyId: string;
  reference: ImportReference;
}) {
  const t = useTranslations('people.import');
  const allocations=useTranslations('costAllocations');
  const information=useTranslations('people.informationCorrection');
  const [choice, setChoice] = useState<PersonnelImportChoice|'cost_allocations'|'information_correction'>('full');
  const [committing, setCommitting] = useState(false);

  // Literal `t()` calls (see the note in section-import.tsx): a computed key is invisible to
  // test/i18n-coverage.test.ts check C, and a missing label would render the raw key on the screen.
  const LABELS: Record<PersonnelImportChoice|'cost_allocations'|'information_correction', { title: string; hint: string }> = {
    information_correction:{title:information('title'),hint:information('hint')},
    cost_allocations:{title:allocations('title'),hint:allocations('importHelp')},
    full: { title: t('sectionFull'), hint: t('sectionFullHint') },
    profile: { title: t('sectionProfile'), hint: t('sectionProfileHint') },
    movement: { title: t('movement.choice'), hint: t('movement.choiceHint') },
    bank_statutory: { title: t('sectionBankStatutory'), hint: t('sectionBankStatutoryHint') },
    family: { title: t('sectionFamily'), hint: t('sectionFamilyHint') },
    qualification:{title:t('sectionQualification'),hint:t('sectionQualificationHint')},
    emergency:{title:t('sectionEmergency'),hint:t('sectionEmergencyHint')},
  };

  return (
    <div className="space-y-6">
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-sm font-medium">
            <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('sectionChooserStep')}
            </span>
            {t('sectionChooserTitle')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('sectionChooserHint')}</p>
        </div>
        <fieldset disabled={committing}>
          <legend className="sr-only">{t('sectionChooserTitle')}</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {([...PERSONNEL_IMPORT_CHOICES,'cost_allocations','information_correction'] as const).map((key) => {
              const selected = choice === key;
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer gap-2 rounded-lg border p-3 transition-colors ${
                    selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="import-section"
                    className="mt-1"
                    value={key}
                    checked={selected}
                    onChange={() => { if (!committing) setChoice(key); }}
                  />
                  <span>
                    <span className="block text-sm font-medium">{LABELS[key].title}</span>{' '}
                    <span className="block text-xs text-muted-foreground">{LABELS[key].hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {/* THE DIVERGENCE, STATED BEFORE A FILE IS CHOSEN. A section file cannot create an employee — it
            carries no name, work email, department, join date or salary to create them FROM — and the
            place to learn that is here, not in a row-level refusal after an upload has failed. */}
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('sectionChooserUpdateOnly')}
        </p>
      </Card>

      {choice!=='cost_allocations'&&choice!=='information_correction'&&<ImportExplanations choice={choice}/>}
      {choice==='information_correction'?<InformationCorrectionImport onCommitPendingChange={setCommitting}/>:choice==='cost_allocations'?<CostAllocationImport onCommitPendingChange={setCommitting}/>:choice === 'full' ? (
        <EmployeeImport companies={companies} defaultCompanyId={defaultCompanyId} reference={reference} onCommitPendingChange={setCommitting} />
      ) : choice==='movement' ? (
        <MovementImport onCommitPendingChange={setCommitting}/>
      ) : (
        // Keyed on the choice so switching sections REMOUNTS the island: the loaded file, the preview
        // and the result all belong to one column contract and must not survive a change of contract.
        <SectionImport key={choice} section={choice} reference={reference} onCommitPendingChange={setCommitting} />
      )}
    </div>
  );
}
