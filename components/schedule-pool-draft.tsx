'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type PoolDraft = { saved: string[]; selected: string[]; setSelected: (ids: string[]) => void };
const Context = createContext<PoolDraft | null>(null);
const samePool = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

export function SchedulePoolDraft({ initial, children }: { initial: string[]; children: ReactNode }) {
  const [saved, setSaved] = useState(initial);
  const [selected, setSelected] = useState(initial);
  useEffect(() => {
    if (samePool(initial, saved)) return;
    if (samePool(selected, saved)) setSelected(initial);
    else if (!samePool(selected, initial)) return;
    setSaved(initial);
  }, [initial, saved, selected]);
  return <Context.Provider value={{saved, selected, setSelected}}>{children}</Context.Provider>;
}

export function useSchedulePoolDraft() { return useContext(Context); }
