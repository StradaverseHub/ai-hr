'use client';
import { onboardingTimestamp } from '@/lib/onboarding-format';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
/** Receives only notes already authorised by the case reader. Storage and task threads stay intact. */
export function PreviousCaseNotes({ notes }: { notes: { id: string; context: string; deleted?: boolean; name: string; at: string; body: string; edited?: boolean }[] }) {
  const copy = useOnboardingCopy(), previous = notes.filter(note => note.context === 'case' && !note.deleted);
  if (!previous.length) return null;
  return <details className="v9-stack"><summary className="v9-link">{copy('Previous case notes')} ({previous.length})</summary><ul className="v9-list">{previous.map(note => <li key={note.id}><strong>{note.name}</strong><p className="v9-muted">{onboardingTimestamp(note.at)}{note.edited ? ' · ' + copy('Edited') : ''}</p><p className="whitespace-pre-wrap break-words">{note.body}</p></li>)}</ul></details>;
}
