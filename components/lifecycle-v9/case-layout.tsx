'use client';
import {useOnboardingCopy} from '@/lib/onboarding-copy';
import type { HTMLAttributes, ReactNode } from 'react';

/** Shared presentation only. Callers retain their domain's visibility and command guards. */
export function CasePageHeader({ eyebrow, title, detail, actions }: { eyebrow: ReactNode; title: ReactNode; detail?: ReactNode; actions?: ReactNode }) {
  return <header className="lifecycle-case-header"><div><p className="text-sm text-muted-foreground">{eyebrow}</p><h1 className="mt-1 text-2xl font-semibold">{title}</h1>{detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}</div><div className="lifecycle-case-actions">{actions}</div></header>;
}
export function CaseSummaryCards({ children }: { children: ReactNode }) { return <div className="onb-summary">{children}</div>; }
export function CaseSummaryCard({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) { const copy=useOnboardingCopy();return <div className="onb-stat"><span className="onb-muted">{copy(label)}</span><strong>{value}</strong>{detail && <span className="onb-muted">{detail}</span>}</div>; }
export function CaseSection({ title, children, className = '', ...props }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode }) { const copy=useOnboardingCopy();return <section {...props} className={`onb-panel lifecycle-case-section ${className}`}>{title && <h2>{typeof title==='string'?copy(title):title}</h2>}{children}</section>; }
export function CaseColumns({ children, single = false }: { children: ReactNode; single?: boolean }) { return <div className={single ? '' : 'onb-columns'}>{children}</div>; }
export function CaseAside({ children }: { children: ReactNode }) { return <aside className="onb-aside" aria-label="Summary">{children}</aside>; }
export function CaseTaskRow({ name, checkbox, metadata, assignment, warning, status, actions, children, done = false }: { name: string; checkbox: ReactNode; metadata: ReactNode; assignment?: ReactNode; warning?: ReactNode; status: ReactNode; actions?: ReactNode; children?: ReactNode; done?: boolean }) {
  return <div className="lifecycle-case-task"><div className="lifecycle-case-task-check">{checkbox}</div><div className="lifecycle-case-task-body"><h3 className={done ? 'font-medium line-through text-muted-foreground' : 'font-medium'}>{name}</h3><p className="lifecycle-case-task-meta">{metadata}</p>{assignment && <div className="lifecycle-case-task-assignee">{assignment}</div>}{warning && <div className="lifecycle-case-task-warning">{warning}</div>}{actions && <div className="lifecycle-case-actions">{actions}</div>}{children}</div><div className="lifecycle-case-task-status">{status}</div></div>;
}
export function CaseItemsTable({ headings, children, label }: { headings: string[]; children: ReactNode; label: string }) { return <div className="onb-table-wrap"><table className="onb-table lifecycle-case-items" aria-label={label}><thead><tr>{headings.map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
export function CaseDocumentsList({ children, empty }: { children: ReactNode; empty?: ReactNode }) { return <ul className="lifecycle-case-documents">{children || <li className="onb-muted">{empty}</li>}</ul>; }
export function CaseDocumentRow({ name, detail, status, actions }: { name: ReactNode; detail: ReactNode; status?: ReactNode; actions: ReactNode }) { return <li><div><strong>{name}</strong><p className="onb-muted">{detail}</p></div>{status}<div className="lifecycle-case-actions">{actions}</div></li>; }

export function CaseNotesDisclosure({count,children,open=false}:{count:number;children:ReactNode;open?:boolean}){const copy=useOnboardingCopy();return <details open={open||undefined} className="lifecycle-case-notes"><summary>{copy('Notes (')}{count})</summary>{children}</details>;}
