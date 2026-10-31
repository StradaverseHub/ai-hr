import {getLocale,getTranslations} from 'next-intl/server';
import {Card,SectionHeader,inputCls} from '@/components/ui';
import {deriveAccumulatorSeed,tp3EpfReliefCap,tp3ExemptionOverLimits,tp3LineNumber,TP3_MAX_EMPLOYERS,TP3_SECTION_C,TP3_SECTION_D,type Tp3Record,type Tp3Identity} from '@/packs/payroll/service';
import {amountField,employerNameField,employerTinField,subField} from '@/lib/tp3-form-input';
import {tp3LineFigures} from '@/lib/tp3-line-figures';
import {timeInKualaLumpur} from '@/lib/hr-date';
import {Tp3PersonalInput,Tp3PersonalSelect,Tp3PersonalDeclaration} from '@/components/tp3-personal-fields';
const box=(value:number|undefined)=>value==null||value===0?'':String(value);
/** Full canonical TP3 sections. Personal mode receives a sanitized record and omits HR notes. */
export async function Tp3DeclarationFields({record,identity,selectedYear,mode='admin',declarationAccepted}:{record:Tp3Record|null;identity:Tp3Identity;selectedYear:number;mode?:'admin'|'personal';declarationAccepted?:boolean}) {
 const t=await getTranslations('taxRelief');
 const c=record?.payload?.sectionC??{},d=record?.payload?.sectionD??{};
 const derived=deriveAccumulatorSeed(record?.payload),overLimits=tp3ExemptionOverLimits(record?.payload),epfCap=tp3EpfReliefCap();
 const unlimitedC2Keyed=(TP3_SECTION_C.find(line=>line.code==='c2')?.subItems??[]).some(sub=>sub.exemptionLimit==null&&Number(c.c2?.subItems?.[sub.code]??0)>0);
 const monthFmt=new Intl.DateTimeFormat(await getLocale(),{month:'long',timeZone:'UTC'});
 const MONTH_OPTIONS=Array.from({length:12},(_,i)=>({value:i+1,label:monthFmt.format(new Date(Date.UTC(2000,i,1)))}));
 const money=(value:number|null)=>value==null?'—':value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const Fig=({v}:{v:number|null})=><span className="w-28 pt-2 text-right text-sm tabular-nums text-muted-foreground">{v==null?'':money(v)}</span>;
 const Input=mode==='personal'?Tp3PersonalInput:'input';
 const Select=mode==='personal'?Tp3PersonalSelect:'select';
 const MoneyInput=({name,value,label}:{name:string;value:number|undefined;label:string})=><Input aria-label={label} type="number" step="0.01" min="0" name={name} defaultValue={box(value)} className={`${inputCls} w-40 max-w-full text-right tabular-nums`}/>;
 return <>
              {/* ── The form's own DEDUCTION MONTH / DEDUCTION YEAR boxes ── */}
              <Card className="p-4">
                <div className="flex flex-wrap gap-6">
                  {/* ── DEDUCTION MONTH — A NAMED MONTH, STORING THE SAME INTEGER (item 20837372) ──
                      The reporter asked for a dropdown of month names instead of a number, and they are
                      right that "3" is a poor thing to ask somebody holding a paper form for. What the
                      value MUST stay is an integer: `core/tp3.ts` `validateMonth` parses 1–12 and
                      `app/(app)/payroll/transactions/tp1/[year]/[month]/page.tsx` matches on
                      `r.deductionMonth === month`. A named value here would match nothing there and the
                      declaration would silently stop opening on its own month, so the option VALUE is
                      the number and only the LABEL is the name.

                      Names come from Intl in the request's own locale, resolved on the SERVER — the
                      same decision `app/(app)/payroll/transactions/tp1/page.tsx` records: twelve names in six
                      locales would be six copies of the calendar in the message catalogue, and the
                      catalogue check cannot tell a wrong month name from a right one. */}
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t('deductionMonthLabel')}</span>
                    <Select
                      name="deductionMonth"
                      defaultValue={record?.deductionMonth == null ? '' : String(record.deductionMonth)}
                      className={`${inputCls} w-44`}
                    >
                      {/* Blank stays reachable: `validateMonth` stores null for "left blank", which is
                          not the same fact as January and must not become it. */}
                      <option value="">{t('tp3.deductionMonthBlank')}</option>
                      {MONTH_OPTIONS.map((m) => (
                        <option key={m.value} value={String(m.value)}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <div className="block text-sm">
                    <span className="mb-1 block font-medium">{t('deductionYearLabel')}</span>
                    <p className="flex h-9 items-center text-sm tabular-nums">{selectedYear}</p>
                  </div>
                </div>
              </Card>

              {/* ── SECTION A ─────────────────────────────────────────────────────────────────── */}
              <Card>
                <SectionHeader title={t('tp3.sectionA')} />
                <div className="space-y-3 p-4">
                  {/* EXACTLY the pairs the form is ruled for. The count comes from the pack, never from
                      a literal here — the form's own footnote sends the next employment to an
                      attachment, and the note below says so rather than the screen inventing a limit. */}
                  {Array.from({ length: TP3_MAX_EMPLOYERS }, (_, i) => {
                    const e = record?.previousEmployers[i];
                    return (
                      <div key={i} className="flex flex-wrap items-end gap-3">
                        <label className="block flex-1 text-sm">
                          <span className="mb-1 block font-medium">
                            A{i * 2 + 1} · {t('tp3.employerNameSlot', { n: i + 1 })}
                          </span>
                          <Input name={employerNameField(i + 1)} defaultValue={e?.name ?? ''} className={inputCls} />
                        </label>
                        <label className="block w-64 text-sm">
                          <span className="mb-1 block font-medium">
                            A{i * 2 + 2} · {t('tp3.employerTinSlot')}
                          </span>
                          <Input name={employerTinField(i + 1)} defaultValue={e?.tin ?? ''} className={inputCls} />
                        </label>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">{t('tp3.sectionAFootnote')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('tp3.maxEmployersNote', { max: TP3_MAX_EMPLOYERS })}
                  </p>
                </div>
              </Card>

              {/* ── SECTION B — read-only: this is the employee record, not a second copy of it ── */}
              <Card>
                <SectionHeader title={t('tp3.sectionB')} />
                <dl className="grid gap-3 p-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">B1 · {t('employeeName')}</dt>
                    <dd className="font-medium">{identity.employee.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">B2 · {t('employeeIdNumber')}</dt>
                    {/* An absent identity number prints an em dash and asserts nothing. */}
                    <dd className="font-medium">{identity.employee.idNumber ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">B3 · {t('employeeTin')}</dt>
                    <dd className="font-medium">{identity.employee.tin ?? '—'}</dd>
                  </div>
                </dl>
              </Card>

              {/* ── SECTION C — the boxes the old single column could not be taken apart into ── */}
              <Card>
                <SectionHeader title={t('tp3.sectionC')} subtitle={t('tp3.sectionCHelp')} />
                <div className="space-y-4 p-4">
                  {/* ── THE EXEMPTION-LIMIT COLUMN (item 20837372) ──────────────────────────────────
                      The reporter asked to see each C2 allowance's own exemption limit beside it, and
                      they were right that a screen showing five bare boxes says nothing about how much
                      of each one may be exempt at all.

                      ⚠️ IT IS HEADED DIFFERENTLY FROM SECTION D'S, ON PURPOSE. Section D's "Annual
                      limit" column is printed on the form itself (`HAD TAHUNAN (RM)`) and the service
                      REFUSES a figure above it. Section C has no limit column on the form at all — one
                      money column, `AMAUN TERKUMPUL (RM)` — so these figures come from the MTD
                      specification's own table (printed page 21) and are guidance for the person
                      keying, never a rule the save enforces. The note below says so in the operator's
                      own words rather than leaving them to infer it from a column heading. */}
                  <p className="text-xs text-muted-foreground">{t('tp3.exemptLimitNote')}</p>
                  <div className="flex flex-wrap justify-end gap-3 text-xs uppercase tracking-wide text-muted-foreground">
                    <span className="w-28 text-right">{t('tp3.colExemptionLimit')}</span>
                    <span className="w-28 text-right">{t('tp3.colTaxExempt')}</span>
                    <span className="w-28 text-right">{t('tp3.colExcess')}</span>
                    <span className="w-28 text-right">{t('tp3.colRemaining')}</span>
                    <span className="w-40 text-right">{t('colAccumulated')}</span>
                  </div>
                  {TP3_SECTION_C.map((line, i) => {
                    const stored = c[line.code];
                    const n = i + 1;
                    return (
                      <div key={line.code} className="border-b border-border pb-3 last:border-0 last:pb-0">
                        <div className="flex flex-wrap items-start gap-3">
                          <span className="w-8 shrink-0 pt-2 text-sm font-semibold">C{n}</span>
                          <p className="min-w-0 flex-1 pt-2 text-sm">{t(`tp3.money.${line.code}.label`)}</p>
                          {line.subItems.length === 0 ? (
                            <>
                              {/* C1 and C5 carry no limit — gross pay and PCB already paid are not
                                  exemptions, so every cell is EMPTY rather than a dash: an absent box
                                  asserts nothing, and a dash would read as "no limit applies".

                                  ⚠️ C3 IS DIFFERENT AND USED TO BE DRAWN HERE AS IF IT WERE NOT. It is
                                  held to the EPF relief cap by `deriveAccumulatorSeed` — the reporter's
                                  own row keyed 8,979 against a 4,000 cap — and until item 20837372 this
                                  branch printed an empty limit cell beside it, so the single largest
                                  capping on the form was the one thing the screen never mentioned. */}
                              {(() => {
                                const lim = line.code === 'c3' ? epfCap : null;
                                const r = tp3LineFigures(stored?.amount, lim);
                                return (
                                  <>
                                    <span className="w-28 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                                      {lim == null ? '' : money(lim)}
                                    </span>
                                    <Fig v={lim == null ? null : r.exempt} />
                                    <Fig v={r.excess} />
                                    <Fig v={r.remaining} />
                                  </>
                                );
                              })()}
                              <MoneyInput label={`C${n} · ${t(`tp3.money.${line.code}.label`)}`} name={amountField('c', line.code)} value={stored?.amount} />
                            </>
                          ) : null}
                        </div>
                        {line.subItems.map((sub) => {
                          const over = overLimits.find((o) => o.code === line.code && o.subCode === sub.code);
                          return (
                            <div key={sub.code} className="mt-2 flex flex-wrap items-start gap-3 pl-11">
                              <span className="w-8 shrink-0 pt-2 text-xs text-muted-foreground">{sub.code})</span>
                              <div className="min-w-0 flex-1 pt-2">
                                <p className="text-sm">{t(`tp3.money.${line.code}.sub.${sub.code}`)}</p>
                                {/* The restriction the form states in words. Captured and printed, never
                                    enforced — enforcing it needs a claim history LHDN holds and we do not. */}
                                {sub.frequency ? (
                                  <p className="text-xs text-muted-foreground">{t(`frequency.${sub.frequency}`)}</p>
                                ) : null}
                                {/* ⚠️ A WARNING, AND THE KEYED FIGURE IS STILL LEFT EXACTLY AS IT IS.
                                    Since r350 the part ABOVE this limit is ADDED to Accumulated Net
                                    Remuneration as taxable pay, which is what the specification's
                                    printed page 20 item 9 requires ("Any amount exceed the restricted
                                    amount shall be taxable"). C1 holds only the TAXABLE items — the
                                    form's own caption says so — so the excess was never in C1 and
                                    cannot be reached by subtracting less; see core/tp3.ts
                                    `deriveAccumulatorSeed` for the full evidence.
                                    THE MESSAGE CHANGED WITH THE RULE. It used to end by telling the
                                    operator the form was probably filled wrong. An over-limit box is
                                    not a keying error — the previous employer may pay more than the
                                    exempt limit — so `tp3.exemptOverLimit` now names the tax
                                    consequence instead, retired key and all, in six locales. The INPUT
                                    is still never refused (ADR-0008). */}
                                {over ? (
                                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                                    {t('tp3.exemptOverLimit', {
                                      limit: money(over.limit),
                                      excess: money(over.excess),
                                    })}
                                  </p>
                                ) : null}
                              </div>
                              <span className="w-28 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                                {sub.exemptionLimit == null ? t('noLimit') : money(sub.exemptionLimit)}
                              </span>
                              {(() => {
                                const r = tp3LineFigures(stored?.subItems?.[sub.code], sub.exemptionLimit);
                                return (
                                  <>
                                    <Fig v={r.exempt} />
                                    <Fig v={r.excess} />
                                    <Fig v={r.remaining} />
                                  </>
                                );
                              })()}
                              <MoneyInput
                                label={`C${n}(${sub.code}) · ${t(`tp3.money.${line.code}.sub.${sub.code}`)}`}
                                name={subField('c', line.code, sub.code)}
                                value={stored?.subItems?.[sub.code]}
                              />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}

                  {/* ── HOW ACCUMULATED NET REMUNERATION IS REACHED ──────────────────────────────
                      ⚠️ THIS BLOCK HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH ARE RECORDED.

                      r345 printed two rows labelled "counted" under a sentence saying the exempt amount
                      "counts towards" ANR, when it was being SUBTRACTED. r348 corrected the words and
                      drew the subtraction with explicit minus signs — and the subtraction itself was the
                      defect. C1 holds only the TAXABLE items ("…YANG DIKENAKAN CUKAI" on the agency's own
                      form), so the exempt allowances were never in C1 and taking them off removed money
                      that was not there. The reporter said so five times; see core/tp3.ts
                      `deriveAccumulatorSeed` for the five independent sources that settle it.

                      It is now the sum the form actually describes: gross, PLUS the part of C2 above its
                      statutory limit (taxable, and not in C1), LESS C3. The exempt total moves out of the
                      arithmetic and into a note, because it explains the figure without being part of it.

                      Every figure is still READ OFF THE SEED and never recomputed: `gross`, `excessTotal`
                      and `epfAllowable` are the same fields `core/tp3.ts` strikes `netRemuneration`
                      against, so these rows cannot drift from the arithmetic they report. Two call sites
                      each working the limits out is the duplicate source of truth §1 forbids.

                      Absent when nothing is keyed yet: a form with no figures has no total, and printing
                      0.00 would assert one. */}
                  {derived ? (
                    <div className="mt-4 space-y-1 border-t-2 border-border pt-3 text-sm" data-anr-working>
                      <div className="flex flex-wrap justify-between gap-2">
                        <span>{t('tp3.totalGross')}</span>
                        <span className="tabular-nums" data-anr-gross>{money(derived.gross)}</span>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-1">
                        <span className="text-muted-foreground">{t('tp3.totalPlusExcess')}</span>
                        <span className="tabular-nums text-muted-foreground" data-anr-plus-excess>
                          + {money(derived.excessTotal)}
                        </span>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-muted-foreground">{t('tp3.totalLessEpf')}</span>
                        <span className="tabular-nums text-muted-foreground" data-anr-less-epf>
                          &minus; {money(derived.epfAllowable)}
                        </span>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2 border-t-2 border-border pt-1 font-semibold">
                        <span>{t('tp3.totalNetRemuneration')}</span>
                        <span className="tabular-nums" data-anr-net>{money(derived.netRemuneration)}</span>
                      </div>
                      {/* THE EXEMPT TOTAL EXPLAINS THE SUM WITHOUT BEING PART OF IT. It is the money
                          that is genuinely exempt, so it is neither added nor subtracted — saying that
                          in words is the whole point, because for five contests running this screen
                          implied otherwise. Shown only when something is keyed in C2. */}
                      {derived.exemptTotal > 0 ? (
                        <p className="pt-1 text-xs text-muted-foreground" data-anr-exempt-note>
                          {t('tp3.totalExemptNote', {
                            entered: money(derived.exemptEntered),
                            exempt: money(derived.exemptTotal),
                            excess: money(derived.excessTotal),
                          })}
                        </p>
                      ) : null}
                      {/* C2(iii) and C2(v) have no sourced limit, so no excess can be PROVEN for them.
                          Named only when one of them actually carries a figure — CLAUDE.md §8: an absent
                          box asserts nothing, and a caption about a box nobody used asserts something. */}
                      {unlimitedC2Keyed ? (
                        <p className="pt-1 text-xs text-muted-foreground" data-anr-nolimit-note>
                          {t('tp3.totalNoLimitNote')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>

              {/* ── SECTION D — THE SHARED RELIEF SCHEDULE. Labels and limits come from the SAME pack
                     catalogue and the SAME message keys the TP1 form uses; only the printed number
                     differs (C1–C17 there, D1–D17 here). ── */}
              <Card>
                <SectionHeader title={t('tp3.sectionD')} subtitle={t('tp3.sectionDHelp')} />
                <div className="space-y-4 p-4">
                  <div className="flex justify-end gap-6 text-xs uppercase tracking-wide text-muted-foreground">
                    <span className="w-40 text-right">{t('colAnnualLimit')}</span>
                    <span className="w-40 text-right">{t('colAccumulated')}</span>
                  </div>
                  {TP3_SECTION_D.map((item) => {
                    const stored = d[item.code];
                    const n = tp3LineNumber(item.code);
                    return (
                      <div key={item.code} className="border-b border-border pb-3 last:border-0 last:pb-0">
                        <div className="flex flex-wrap items-start gap-3">
                          <span className="w-8 shrink-0 pt-2 text-sm font-semibold">D{n}</span>
                          <div className="min-w-0 flex-1 pt-2">
                            <p className="text-sm">{t(`items.${item.code}.label`)}</p>
                            {item.frequency ? (
                              <p className="text-xs text-muted-foreground">{t(`frequency.${item.frequency}`)}</p>
                            ) : null}
                          </div>
                          {/* A perSubLimit item (D16) has NO group limit and NO group box: the form gives
                              each house-price band its own limit and its own accumulated row. */}
                          {item.perSubLimit ? null : (
                            <>
                              <span className="w-40 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                                {item.limit == null ? t('noLimit') : money(item.limit)}
                              </span>
                              {item.subItems.length === 0 ? (
                                <MoneyInput label={`D${n} · ${t(`items.${item.code}.label`)}`} name={amountField('d', item.code)} value={stored?.amount} />
                              ) : (
                                <span className="w-40 pt-2 text-right text-sm tabular-nums">
                                  {stored?.amount ? money(stored.amount) : ''}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        {item.subItems.map((sub) => (
                          <div key={sub.code} className="mt-2 flex flex-wrap items-start gap-3 pl-11">
                            <span className="w-8 shrink-0 pt-2 text-xs text-muted-foreground">{sub.code})</span>
                            <p className="min-w-0 flex-1 pt-2 text-sm">{t(`items.${item.code}.sub.${sub.code}`)}</p>
                            <span className="w-40 pt-2 text-right text-sm tabular-nums text-muted-foreground">
                              {sub.limit == null ? '' : money(sub.limit)}
                            </span>
                            <MoneyInput
                              label={`D${n}(${sub.code}) · ${t(`items.${item.code}.sub.${sub.code}`)}`}
                              name={subField('d', item.code, sub.code)}
                              value={stored?.subItems?.[sub.code]}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* ── SECTION E ──────────────────────────────────────────────────────────────────── */}
              <Card>
                <SectionHeader title={t('tp3.sectionE')} />
                <div className="space-y-3 p-4">
                  <p className="text-sm">{t('declarationText')}</p>
                  {/* RULE 17 — the hidden `no` goes FIRST and the checkbox contributes `yes`, so the
                      reader can ask whether 'yes' is among the values. A hidden input is always
                      submitted, so presence can never answer this. */}
                  <input type="hidden" name="declarationAccepted" value="no" />
                  <label className="flex items-center gap-2 text-sm">
                    {mode==='personal'?<Tp3PersonalDeclaration defaultChecked={declarationAccepted??(record?.declaredAt != null)} className="size-4"/>:<input
                      type="checkbox"
                      name="declarationAccepted"
                      value="yes"
                      defaultChecked={declarationAccepted??(record?.declaredAt != null)}
                      className="size-4"
                    />}
                    {t('tp3.declarationTick')}
                  </label>
                  {record?.declaredAt ? (
                    <p className="text-xs text-muted-foreground">
                      {t('declaredOn', { at: timeInKualaLumpur(record.declaredAt) })}
                    </p>
                  ) : null}
                  {mode==='admin'&&<>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t('remarksLabel')}</span>
                    <textarea
                      name="remarks"
                      defaultValue={record?.remarks ?? ''}
                      rows={2}
                      className={`${inputCls} h-auto`}
                    />
                  </label>
                  </>}
                </div>
              </Card>

 </>;
}
