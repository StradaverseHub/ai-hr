/**
 * 289634a6 — the import log states each employee-month's outcome in plain words ABOVE its Pay Item lines.
 *
 * A repeat "Update Listed Pay Item Totals" upload whose totals were already saved printed "Keep existing total"
 * on every line and nothing else, which read as "the lines were skipped". Each employee-month now says
 * "Updated", "New" or "No change — these totals were already saved" first. Real component, real catalogues,
 * fictional plan rows; no service is called.
 */
import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {RevisionPreview} from '../app/payroll/history-import/revision-preview';
import {maintenancePlan} from './fixtures/payroll-history/maintenance';
import type {HistoryRevisionPlan,HistoryRevisionRow} from '../lib/payroll-history-revisions';

const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(cleanup);
const base=maintenancePlan.rows[0];
const plan=(rows:HistoryRevisionRow[]):HistoryRevisionPlan=>({...maintenancePlan,rows,counts:{created:rows.filter(r=>r.operation==='create').length,replaced:rows.filter(r=>r.operation==='replace').length,unchanged:rows.filter(r=>r.operation==='unchanged').length,invalid:rows.filter(r=>r.operation==='invalid').length}});
const unchanged:HistoryRevisionRow={...base,employeeNo:'BD0098',period:'2026-01',operation:'unchanged',itemChanges:[
 {key:'component:bkdrv',code:'BKDRV',label:'Benefit-in-kind driver',before:'600.00',after:'600.00',operation:'keep'},
 {key:'component:bkcar',code:'BKCAR',label:'Benefit-in-kind car',before:'2083.33',after:'2083.33',operation:'keep'},
]};
const updated:HistoryRevisionRow={...base,employeeNo:'BD0098',period:'2026-02',operation:'replace'};
const created:HistoryRevisionRow={...base,employeeNo:'BD0099',period:'2026-01',operation:'create',recordId:null,expectedRevisionId:null,expectedSnapshotId:null,beforeValues:null,itemChanges:[{key:'component:bkcar',code:'BKCAR',label:'Benefit-in-kind car',before:null,after:'2083.33',operation:'add'}]};

it('states the outcome of each employee-month above its item lines', () => {
 render(<NextIntlClientProvider locale="en" messages={en}><RevisionPreview plan={plan([unchanged,updated,created])}/></NextIntlClientProvider>);
 const sections=screen.getAllByRole('region',{name:en.payrollHistoryMaintenance.itemComparison});
 expect(sections).toHaveLength(3);
 const outcome=(section:HTMLElement)=>section.querySelector('[data-row-operation]');
 expect(outcome(sections[0])).toHaveTextContent('No change — these totals were already saved');
 expect(outcome(sections[1])).toHaveTextContent('Updated');
 expect(outcome(sections[2])).toHaveTextContent('New');
 // The outcome precedes the item lines, and the item lines keep their own per-item wording.
 const first=sections[0];
 expect(outcome(first)!.compareDocumentPosition(within(first).getAllByText(en.payrollHistoryMaintenance.itemOperations.keep)[0])&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(within(first).getByText('BKCAR · Benefit-in-kind car')).toBeInTheDocument();
});

it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the outcome words from the %s catalogue, never a raw key', (locale) => {
 const t=catalogues[locale].payrollHistoryMaintenance.rowOperations;
 render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><RevisionPreview plan={plan([unchanged,updated,created])}/></NextIntlClientProvider>);
 for(const words of [t.unchanged,t.replace,t.create])expect(screen.getAllByText(words).length).toBeGreaterThan(0);
 expect(screen.queryByText(/rowOperations\./)).not.toBeInTheDocument();
});
