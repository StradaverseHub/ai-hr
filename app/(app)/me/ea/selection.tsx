'use client';
import { useState } from 'react';
import { Button, inputCls } from '@/components/ui';

export type MyEaChoice = {
  employmentId: string; companyId: string; company: string;
  employeeCode: string | null; year: string;
};
const identity = (row: MyEaChoice) => `${row.employmentId}|${row.companyId}`;
export function MyEaSelection({ sources, selected, language, labels }: {
  sources: MyEaChoice[]; selected: MyEaChoice; language: 'en' | 'ms';
  labels: { year: string; employer: string; language: string; view: string };
}) {
  const [year, setYear] = useState(selected.year);
  const [employer, setEmployer] = useState(identity(selected));
  const choices = sources.filter(row => row.year === year);
  const chosen = choices.find(row => identity(row) === employer) ?? choices[0];
  const years = [...new Set(sources.map(row => row.year))].sort().reverse();
  return <form method="GET" className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[8rem_minmax(0,1fr)_12rem_auto]">
    <label className="space-y-1 text-sm font-medium">{labels.year}
      <select name="year" className={inputCls} value={year} onChange={event => setYear(event.target.value)}>
        {years.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    <label className="space-y-1 text-sm font-medium">{labels.employer}
      <select className={inputCls} value={chosen ? identity(chosen) : ''} onChange={event => setEmployer(event.target.value)}>
        {choices.map(row => <option key={identity(row)} value={identity(row)}>{[row.company, row.employeeCode].filter(Boolean).join(' · ')}</option>)}
      </select>
    </label>
    <input type="hidden" name="employmentId" value={chosen?.employmentId ?? ''}/>
    <input type="hidden" name="company" value={chosen?.companyId ?? ''}/>
    <label className="space-y-1 text-sm font-medium">{labels.language}
      <select name="lang" defaultValue={language} className={inputCls}><option value="en">English</option><option value="ms">Bahasa Malaysia</option></select>
    </label>
    <Button type="submit" className="min-h-11">{labels.view}</Button>
  </form>;
}
