'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config, ConfigSaveReceipt } from '@/lib/lifecycle-v9-model';
type Receipt = ConfigSaveReceipt;
type Result = { ok: true; result: Receipt } | { ok: false; error: string };
type State = 'saved' | 'pending' | 'saving' | 'error';
/** Serialize settings writes while retaining edits made during an outstanding request. */
export function useV9Configuration(initial: Config | null, save: (revision: number, value: Config) => Promise<Result>, refreshed: () => void, delay = 500) {
  const [draft, setDraft] = useState(initial), [state, setState] = useState<State>('saved'), [error, setError] = useState('');
  const latest = useRef(initial), generation = useRef(0), savedGeneration = useRef(0), active = useRef(true), inFlight = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baselineGroups = useRef(structuredClone(initial?.groups ?? []));
  const revision = useRef(initial?.revision ?? 0), groupsRevision = useRef(initial?.groupsRevision ?? 0), saveRef = useRef(save), refreshedRef = useRef(refreshed), runRef = useRef<() => Promise<void>>(async () => {});
  saveRef.current = save; refreshedRef.current = refreshed;
  const schedule = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; void runRef.current(); }, delay); }, [delay]);
  runRef.current = async () => {
    if (!active.current || inFlight.current || !latest.current || generation.current === savedGeneration.current) return;
    const sentGeneration = generation.current, expected = revision.current;
    const value = { ...structuredClone(latest.current), revision: expected, groupsRevision: groupsRevision.current };
    inFlight.current = true; setState('saving'); setError('');
    try {
      const result = await saveRef.current(expected, value);
      if (!active.current) return;
      if (!result.ok) { setError(result.error); setState('error'); return; }
      revision.current = result.result.revision; groupsRevision.current = result.result.groupsRevision; savedGeneration.current = sentGeneration;
      baselineGroups.current = structuredClone(value.groups);
      const next = structuredClone(latest.current!);
      for (const stamp of result.result.versionStamps ?? []) {
        const version = next.templates.find(template => template.id === stamp.templateId)?.versions.find(version => version.version === stamp.version);
        if (version?.state === stamp.state) { version.at = stamp.at; version.by = stamp.by; }
      }
      latest.current = { ...next, revision: revision.current, groupsRevision: groupsRevision.current };
      setDraft(latest.current);
      if (generation.current !== sentGeneration) { setState('pending'); schedule(); }
      else { setState('saved'); refreshedRef.current(); }
    } catch { if (active.current) { setError('Changes could not be saved. Your edits are still here. Try again.'); setState('error'); } }
    finally { inFlight.current = false; }
  };
  useEffect(() => { active.current = true; return () => { active.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    // Groups have their own canonical writer. Refresh that read-only reference without
    // replacing pending workflow/template edits, but never overwrite an intended group edit.
    if (initial && latest.current && !inFlight.current && (initial.groupsRevision ?? 0) > groupsRevision.current && JSON.stringify(latest.current.groups) === JSON.stringify(baselineGroups.current)) {
      groupsRevision.current = initial.groupsRevision ?? 0; baselineGroups.current = structuredClone(initial.groups);
      latest.current = { ...latest.current, groups: structuredClone(initial.groups), groupsRevision: groupsRevision.current }; setDraft(latest.current);
    }
    if (inFlight.current || generation.current !== savedGeneration.current || initial && initial.revision < revision.current) return;
    latest.current = initial; revision.current = initial?.revision ?? 0; groupsRevision.current = initial?.groupsRevision ?? 0; baselineGroups.current = structuredClone(initial?.groups ?? []); setDraft(initial);
  }, [initial, state]);
  function edit(change: (value: Config) => void) {
    if (!latest.current) return;
    const next = structuredClone(latest.current); change(next); latest.current = next; generation.current++; setDraft(next); setState(inFlight.current ? 'saving' : 'pending'); setError(''); schedule();
  }
  function retry() { if (timer.current) { clearTimeout(timer.current); timer.current = null; } void runRef.current(); }
  return { draft, edit, state, error, retry };
}
