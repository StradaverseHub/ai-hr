import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {listIndividualImportRows} from '@/packs/payroll/service';

/**
 * 0ec0ee00 — one page of a batch's rows, read and paged in SQL (docs/SCALE-AND-RELEASE-RULES.md rule 2), so a
 * 10,000-row import opens as quickly as a 10-row one. `pageHref(n)` links the pager back to the hosting page.
 *
 * 7b5b1665 — each row shows its Input Type in words, the Quantity and Amount as the file gave them, and what the row
 * will pay (the figure Confirm Import writes); a formula Pay Item row also says whether its formula is used.
 */
export async function IndividualImportRows({attemptId, page, pageHref}: {attemptId: string; page: number; pageHref: (page: number) => string}) {
 const {s, scopeIds} = await scopedAdmin();
 const t = await getTranslations('payroll.individualImport'), old = await getTranslations('payroll.txnImport');
 const result = await listIndividualImportRows(s, attemptId, scopeIds, page);
 const first = result.rows[0]?.rowNum, last = result.rows.at(-1)?.rowNum;
 const status = (outcome: string) => outcome === 'valid' ? old('statusValid') : outcome === 'pending' ? t('pending') : t(outcome as 'invalid' | 'imported');
 return <section className="my-6 space-y-3">
  <div className="overflow-x-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{(['row','employee','payItem','month','cycle','effectiveDate','inputType','quantity','amount','willPay','remark','outcome'] as const).map(k=><th key={k} className="p-3">{t(k)}</th>)}</tr></thead>
  <tbody>{result.rows.map(item=>{const input=item.record,row=item.row,type=(row?.inputType||input?.__input_unit||item.snapshotUnit||'').trim().toLowerCase();return <tr key={item.rowNum} className="border-t border-border">
   <td className="p-3">{item.rowNum}</td><td className="p-3">{row?.employeeId} · {row?.employeeName}</td><td className="p-3">{row?.payItemCode} · {row?.payItem}</td>
   <td className="p-3">{input?.__pay_period}</td><td className="p-3">{input?.__configured_cycle}</td><td className="p-3">{row?.effectiveFrom}</td>
   <td className="p-3">{type?t('inputTypeName',{type}):''}</td><td className="p-3">{row?.calculationMethod==='amount'?'':row?.inputValue??input?.quantity}</td><td className="p-3">{input?.amount}</td>
   <td className="p-3">{row?.ok&&row.amount?t('willPayAmount',{amount:row.amount}):'—'}</td><td className="p-3">{input?.notes}</td>
   <td className="p-3"><p>{status(item.outcome)}</p>{row?.ok&&row.calculationMethod&&<p>{t(row.calculationMethod==='amount'?'methodAmountNote':'methodFormulaNote')}</p>}{row&&!row.ok&&<p>{old.has(`reason.${row.reason}`)?old(`reason.${row.reason}` as never,(row.detail??{}) as never):t('failed')}</p>}{row?.warnings?.map((w,i)=><p key={i}>{old(`warning.${w.reason}` as never,(w.detail??{}) as never)}</p>)}</td>
  </tr>;})}</tbody></table></div>
  {result.pages > 1 && first != null && last != null && <nav className="flex flex-wrap items-center gap-4 text-sm">
   <span className="text-muted-foreground">{t('pageRows', {from: first - 1, to: last - 1, total: result.total})}</span>
   {result.page > 0 && <Link className="text-primary underline" href={pageHref(result.page - 1)}>{t('previousPage')}</Link>}
   {result.page < result.pages - 1 && <Link className="text-primary underline" href={pageHref(result.page + 1)}>{t('nextPage')}</Link>}
  </nav>}
 </section>;
}
