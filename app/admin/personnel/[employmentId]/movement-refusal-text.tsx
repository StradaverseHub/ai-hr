'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DatabaseErrorText } from '@/components/database-error-text';
import { movementRecordAnchor, splitMovementRecordMarker } from '@/lib/assignment-blocked-message';
import { movementPageHref, type MovementPageContext } from '@/lib/personnel-movement-navigation';

/** Board eb01800b — the New Event refusal; when it names a later record, a link goes to that record's line. */
export function MovementRefusalText({ message, employmentId, context }: { message: string; employmentId: string; context?: MovementPageContext }) {
  const t = useTranslations('people.detail.assignmentBlocked');
  const { text, versionId } = splitMovementRecordMarker(message);
  return (
    <>
      <DatabaseErrorText message={text} />
      {versionId && (
        <>
          {' '}
          <Link
            href={`${movementPageHref(employmentId, 'history', undefined, context)}#${movementRecordAnchor(versionId)}`}
            data-movement-record-link={versionId}
            className="font-medium underline underline-offset-2"
          >
            {t('goToRecord')}
          </Link>
        </>
      )}
    </>
  );
}
