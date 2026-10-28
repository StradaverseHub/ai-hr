import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import type { getOnehrCycle } from '@/packs/performance/service';
import { pmBands, assessmentModuleKeys, ratedPerformance, tiers, windowCells } from '@/packs/performance/onehr/model';
import type { ProgressModule } from '@/packs/performance/onehr/progress-model';
import { adminCardShown, adminPartShown, type AdminCardId, type AdminCycleState, type AdminPart } from '@/packs/performance/onehr/admin-sections';
import { FrameworkAdmin } from './framework-admin';
import { AssessmentProgressAdmin } from './progress-admin';
import { AssessmentReminderAdmin } from './reminder-admin';
import { PanelAdmin } from './panel-admin';
import { CatalogueAdmin, type CatalogueSection } from './catalogue-admin';
import { AssessmentParticipants } from './participants';
import { UnitExclusionAdmin } from './unit-exclusion-admin';
import { CompanyKpiFill } from './company-kpi';
import { AssessmentKpiImport } from './kpi-import';
import { onehrCycleAction } from '../onehr-actions';
import { GenerateCalibrationScopes } from '../leaders/generate-scopes';
import { openCycleAction, calibrateAction, closeAction } from '../actions';

type View=NonNullable<Awaited<ReturnType<typeof getOnehrCycle>>>;
export type ProgressQuery={progressModule?:string;progressKind?:string;progressGroup?:string;progressCompany?:string};
const local=(s:string|null|undefined)=>s?new Date(Date.parse(s)+8*3600000).toISOString().slice(0,16):'';
/** Each Run tab's Review progress is one module (and, for 360, one kind), fixed; the place filters still pass through. */
const fixedProgress:Record<Extract<AdminPart,`progress.${string}`>,{progressModule:ProgressModule;progressKind:'assessments'|'assessors'}>={
 'progress.pm':{progressModule:'pm',progressKind:'assessments'},
 'progress.feedback':{progressModule:'feedback',progressKind:'assessments'},
 'progress.assessors':{progressModule:'feedback',progressKind:'assessors'},
 'progress.competency':{progressModule:'competency',progressKind:'assessments'},
 'progress.calibration':{progressModule:'calibration',progressKind:'assessments'},
 'progress.career':{progressModule:'career',progressKind:'assessments'},
};
const catalogueSectionOf:Record<Extract<AdminPart,`catalogue.${string}`>,CatalogueSection>={'catalogue.import':'import','catalogue.profiles':'profiles','catalogue.routes':'routes','catalogue.generate':'generate'};

/**
 * D-P1-32 PT-X4 — the cycle page's cards, owned once. `card` draws a card whole, as the old cycle page always has
 * (D8); `part` draws one part for its admin page (packs/performance/onehr/admin-sections.ts says which page, and
 * adminPartShown when). The JSX is the cycle page's own, moved here unchanged; `returnTo` (an admin page's own
 * address) rides the forms so a save comes back to the page it was made on.
 */
export async function adminCardRenderer(v:View,{progress,returnTo}:{progress?:ProgressQuery;returnTo?:string}={}){
  const t=await getTranslations('onehr');const {cycle,policy}=v;
  const state:AdminCycleState={status:cycle.status,policy,kpiNames:v.kpiNames.length};
  const back=returnTo?<input type="hidden" name="returnTo" value={returnTo}/>:null;
  const fields=<><input type="hidden" name="cycleId" value={cycle.id}/><input type="hidden" name="revision" value={v.revision}/>{back}</>;
  const windowFields=<fieldset className="space-y-3"><legend className="mb-2 font-medium">{t('windows')}</legend><p className="text-sm text-muted-foreground">{t('windowHelp')}</p>{windowCells.map(cell=><fieldset key={cell} className="grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium">{t(`windowNames.${cell}`)}</legend><Field label={t('opens')}><input type="datetime-local" name={`${cell}.opens`} defaultValue={local(policy.windows[cell]?.opensAt)} className={inputCls}/></Field><Field label={t('closes')}><input type="datetime-local" name={`${cell}.closes`} defaultValue={local(policy.windows[cell]?.closesAt)} className={inputCls}/></Field></fieldset>)}</fieldset>;
  const live=adminPartShown('calibration.groups',state);
  const sessions=<>{v.sessions.map(s=><p key={s.id}><Link className="text-primary hover:underline" href={`/performance/assessment/calibration/${s.id}`}>{s.name} · {t(`tiers.${s.tier}`)}</Link> · {s.lockedAt?t('locked'):t('pending')}{s.tier==='group'&&ratedPerformance(policy)&&<> · <Link className="text-primary hover:underline" href={`/performance/assessment/calibration/${s.id}?view=final-bands`}>{t('finalBands.title')}</Link></>}</p>)}</>;
  const groups=<>{live&&<GenerateCalibrationScopes cycleId={cycle.id}/>}{live&&<details><summary className="cursor-pointer font-medium">{t('assignCalibration')}</summary><form action={onehrCycleAction} className="mt-4 space-y-4">{fields}<input type="hidden" name="action" value="calibration"/><div className="grid gap-4 sm:grid-cols-2"><Field label={t('name')}><input required name="name" maxLength={300} className={inputCls}/></Field><Field label={t('tier')}><select name="tier" className={inputCls}>{tiers.map(k=><option key={k} value={k}>{t(`tiers.${k}`)}</option>)}</select></Field><Field label={t('company')}><select name="companyId" className={inputCls} defaultValue={cycle.companyId??''}><option value="">{t('group')}</option>{v.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label={t('groupMode')}><select name="mode" className={inputCls}>{['after','replace','blend'].map(k=><option key={k} value={k}>{t(`groupModes.${k}`)}</option>)}</select></Field><Field label={t('finalBands.bgWeight')}><input type="number" name="bgWeight" min="1" max="99" defaultValue="50" className={inputCls}/></Field></div><fieldset className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-3"><legend>{t('reviewers')}</legend>{v.users.map(u=><label key={u.id} className="flex gap-2 text-sm"><input type="checkbox" name="reviewerIds" value={u.id}/>{u.name??u.email??u.id}</label>)}</fieldset><fieldset className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-3"><legend>{t('cohort')}</legend>{v.reviews.map(r=><label key={r.reviewId} className="flex gap-2 text-sm"><input type="checkbox" name="reviewIds" value={r.reviewId} disabled={!!r.frozenId||v.participants.some(p=>p.employmentId===r.employmentId&&!p.takingPart)}/>{r.name} · {r.grade}</label>)}</fieldset><Button type="submit">{t('assignCalibration')}</Button></form></details>}</>;
  const progressCard=(initial:ProgressQuery|undefined,fixed:boolean)=><section id="progress"><AssessmentProgressAdmin cycleId={cycle.id} initial={initial} fixed={fixed}/></section>;
  const catalogueCard=(sections?:readonly CatalogueSection[])=><section id="catalogue"><CatalogueAdmin cycleId={cycle.id} revision={v.revision} policy={policy} companies={v.companies} sections={sections} returnTo={returnTo}/></section>;
  const place={progressGroup:progress?.progressGroup,progressCompany:progress?.progressCompany};
  const parts:Record<AdminPart,()=>ReactNode>={
    cycleActions:()=><Card className="space-y-4 p-5"><h2 className="font-semibold">{t('cycleActions')}</h2><div className="flex flex-wrap gap-3">{cycle.status==='draft'&&<form action={openCycleAction}>{fields}<ConfirmSubmit description={t('policyHelp')} variant="secondary">{t('openCycle')}</ConfirmSubmit></form>}{cycle.status==='open'&&<form action={calibrateAction}>{fields}<Button type="submit" variant="secondary">{t('startCalibration')}</Button></form>}{['open','calibration'].includes(cycle.status)&&<form action={closeAction}>{fields}<ConfirmSubmit description={t('archiveHelp')} variant="secondary">{t('closeCycle')}</ConfirmSubmit></form>}</div><p className="text-sm text-muted-foreground">{t('cycleHelp')}</p></Card>,
    policy:()=><Card id="policy" className="space-y-4 p-5"><details open={cycle.status==='draft'}><summary className="cursor-pointer font-semibold">{t('policy')}</summary><p className="my-4 max-w-3xl text-sm text-muted-foreground">{t('policyHelp')}</p><form action={onehrCycleAction}><fieldset disabled={cycle.status!=='draft'} className="space-y-6">{fields}<input type="hidden" name="action" value="policy"/><Field label={t('cycleKind')}><select name="kind" defaultValue={policy.kind} className={inputCls}>{['mid_year','year_end','quarterly'].map(k=><option key={k} value={k}>{t(`cycleKinds.${k}`)}</option>)}</select></Field><fieldset className="flex flex-wrap gap-5"><legend className="mb-2 font-medium">{t('modules')}</legend>{assessmentModuleKeys.map(k=><label key={k} className="flex gap-2 text-sm"><input type="checkbox" name={k} defaultChecked={policy.modules[k as keyof typeof policy.modules]!==false}/>{t(`modulesNames.${k}`)}</label>)}</fieldset>
      <Field label={t('curveToleranceMode')}><select name="curveToleranceMode" defaultValue={policy.curveToleranceMode} className={inputCls}><option value="people">{t('curvePeople')}</option><option value="percent">{t('curvePercent')}</option></select></Field><div className="grid gap-4 sm:grid-cols-3">{(['lowMaxPct','midMaxPct','minValid','panelTarget','idpMinGoals','idpMaxGoals','curveTolerancePct','curveTolerancePeople'] as const).map(k=><Field key={k} label={t(k)}><input required type="number" min="0" step={k.includes('Pct')?'any':'1'} name={k} defaultValue={policy[k]} className={inputCls}/></Field>)}</div><label className="flex gap-2 text-sm"><input type="checkbox" name="idpRequireAllActions" defaultChecked={policy.idpRequireAllActions}/>{t('requireAllActions')}</label><label className="flex gap-2 text-sm"><input type="checkbox" name="curveStrict" defaultChecked={policy.curveStrict}/>{t('strictCurve')}</label>
      <fieldset><legend className="mb-2 font-medium">{t('aBands')}</legend><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{pmBands.map((b,i)=><Field key={b} label={b}><input required type="number" step="any" name={`a.${i}`} defaultValue={policy.aBands[i]} className={inputCls}/></Field>)}</div></fieldset>
      <fieldset className="space-y-3"><legend className="mb-2 font-medium">{t('bBands')}</legend><p className="text-sm text-muted-foreground">{t('bBandsHelp')}</p>{v.companies.map(c=><fieldset key={c.id}><legend className="mb-2 text-sm">{c.name}</legend><Field label={t('variant')}><select name={`b.${c.id}.variant`} defaultValue={policy.bBands.find(x=>x.companyId===c.id)?.variant??'base'} className={inputCls}><option value="base">{t('base')}</option><option value="excellence">{t('excellence')}</option></select></Field><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{pmBands.map((b,i)=><Field key={b} label={b}><input type="number" step="any" name={`b.${c.id}.${i}`} defaultValue={policy.bBands.find(x=>x.companyId===c.id)?.minima[i]??''} className={inputCls}/></Field>)}</div></fieldset>)}</fieldset>
      {windowFields}
      <fieldset className="space-y-3"><legend className="font-medium">{t('weights')}</legend><div className="grid gap-3 sm:grid-cols-4">{Object.entries(policy.weights).map(([grade,value])=><Field key={grade} label={grade}><input type="number" name={`weight.${grade}`} required min="0" max="100" step="0.01" defaultValue={value/100} className={inputCls}/></Field>)}</div></fieldset><label className="flex gap-2 text-sm"><input type="checkbox" name="extremes" defaultChecked={policy.extremes.enabled}/>{t('extremes')}</label><div className="grid gap-3 sm:grid-cols-2"><Field label={t('bonus')}><input type="number" required min="0" step="any" name="bonus" defaultValue={policy.extremes.bonus} className={inputCls}/></Field><Field label={t('penalty')}><input type="number" required min="0" step="any" name="penalty" defaultValue={policy.extremes.penalty} className={inputCls}/></Field></div><a href={`/performance/assessment/catalogue/${cycle.id}`} className="inline-block text-sm text-primary hover:underline">{t('exportCatalogue')}</a><Field label={t('catalogue')}><input type="file" name="catalogue" accept=".json,application/json" className="text-sm"/></Field><p className="text-sm text-muted-foreground">{t('catalogueHelp')}</p>{cycle.status==='draft'&&<Button type="submit">{t('savePolicy')}</Button>}</fieldset></form></details></Card>,
    modules:()=><Card className="space-y-4 p-5"><h2 id="modules" className="font-semibold">{t('modules')}</h2><p className="text-sm text-muted-foreground">{t('moduleSwitchHelp')}</p><form action={onehrCycleAction} className="space-y-4">{fields}<input type="hidden" name="action" value="modules"/><fieldset className="flex flex-wrap gap-5">{assessmentModuleKeys.map(k=><label key={k} className="flex gap-2 text-sm"><input type="checkbox" name={k} defaultChecked={policy.modules[k]!==false}/>{t(`modulesNames.${k}`)}</label>)}</fieldset><Button type="submit">{t('saveModules')}</Button></form></Card>,
    windows:()=><Card className="space-y-4 p-5"><h2 id="calendar" className="font-semibold">{t('windows')}</h2><p className="text-sm text-muted-foreground">{t('activeWindowHelp')}</p><form action={onehrCycleAction} className="space-y-4">{fields}<input type="hidden" name="action" value="windows"/>{windowFields}<Field label={t('windowChangeReason')}><textarea required name="reason" maxLength={4000} className={inputCls}/></Field><Button type="submit">{t('saveWindows')}</Button></form></Card>,
    participants:()=><Card id="participants" className="p-5"><AssessmentParticipants cycleId={cycle.id} returnTo={returnTo} revision={v.revision} participants={v.participants} frozenEmploymentIds={v.reviews.filter(r=>r.frozenId).map(r=>r.employmentId)} labels={Object.fromEntries(['title','help','search','filter','out','changed','all','employee','status','actions','add','remove','clear','empty','previous','next','added','removed','confirmed','not_confirmed','confirmed_after_open','left','native_rule','existing_review','unit_out','noReview'].map(k=>[k,t(`participants.${k}`)]))}/></Card>,
    units:()=><section id="units"><UnitExclusionAdmin cycleId={cycle.id}/></section>,
    'progress.pm':()=>progressCard({...place,...fixedProgress['progress.pm']},true),
    'progress.feedback':()=>progressCard({...place,...fixedProgress['progress.feedback']},true),
    'progress.assessors':()=>progressCard({...place,...fixedProgress['progress.assessors']},true),
    'progress.competency':()=>progressCard({...place,...fixedProgress['progress.competency']},true),
    'progress.calibration':()=>progressCard({...place,...fixedProgress['progress.calibration']},true),
    'progress.career':()=>progressCard({...place,...fixedProgress['progress.career']},true),
    panels:()=><section id="panels"><PanelAdmin cycleId={cycle.id}/></section>,
    framework:()=><section id="framework"><FrameworkAdmin cycleId={cycle.id} revision={v.revision} policy={policy} closed={cycle.status==='closed'} returnTo={returnTo}/></section>,
    'catalogue.import':()=>catalogueCard([catalogueSectionOf['catalogue.import']]),
    'catalogue.profiles':()=>catalogueCard([catalogueSectionOf['catalogue.profiles']]),
    'catalogue.routes':()=>catalogueCard([catalogueSectionOf['catalogue.routes']]),
    'catalogue.generate':()=>catalogueCard([catalogueSectionOf['catalogue.generate']]),
    kpiImport:()=><section id="kpi-import"><AssessmentKpiImport cycleId={cycle.id}/></section>,
    companyKpi:()=><CompanyKpiFill cycleId={cycle.id} companies={v.companies} names={v.kpiNames}/>,
    assessments:()=><Card className="space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="assessments" className="font-semibold">{t('assessments')} ({v.reviews.length})</h2><span className="flex flex-wrap gap-4"><Link href={`/performance/${cycle.id}/release`} className="text-sm text-primary hover:underline">{t('resultRelease.open')}</Link><Link href={`/performance/${cycle.id}/records`} className="text-sm text-primary hover:underline">{t('records.title')}</Link></span></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['employee','grade','managerAssessment','finalResult'].map(k=><th className="p-3" key={k}>{t(k)}</th>)}</tr></thead><tbody className="divide-y divide-border">{v.reviews.map(r=><tr key={r.reviewId}><td className="p-3"><Link className="text-primary hover:underline" href={`/performance/review/${r.reviewId}`}>{r.name}</Link></td><td className="p-3">{r.grade}</td><td className="p-3">{r.managerPerformance??'—'}</td><td className="p-3">{r.frozenId?t('finalized'):t('pending')}</td></tr>)}</tbody></table></div></Card>,
    profit:()=><Card className="space-y-4 p-5"><h2 id="profit" className="font-semibold">{t('talentCurve.configuration')}</h2><p className="text-sm text-muted-foreground">{t('talentCurve.configurationHelp')}</p>{v.companies.filter(unit=>unit.profitEligible).map(unit=>{const figure=v.profitAchievements.find(row=>row.companyId===unit.id);return <form key={unit.id} action={onehrCycleAction} className="flex flex-wrap items-end gap-3">{fields}<input type="hidden" name="action" value="profit-achievement"/><input type="hidden" name="companyId" value={unit.id}/><input type="hidden" name="profitRevision" value={figure?.revision??''}/><Field label={unit.name}><input aria-label={t('talentCurve.inputFor',{name:unit.name})} name="achievementPct" type="number" step="any" defaultValue={figure?.achievementPct??''} disabled={cycle.status==='closed'} className={inputCls}/></Field><Button type="submit" variant="secondary" disabled={cycle.status==='closed'}>{t('save')}</Button></form>;})}</Card>,
    reminders:()=><section id="reminders"><AssessmentReminderAdmin cycleId={cycle.id} returnTo={returnTo}/></section>,
    'calibration.sessions':()=><Card className="space-y-4 p-5"><h2 id="calibration" className="font-semibold">{t('calibration')}</h2>{sessions}</Card>,
    'calibration.groups':()=><Card className="space-y-4 p-5"><h2 className="font-semibold">{t('calibration')}</h2>{groups}</Card>,
  };
  // The old page's three multi-part cards, whole: one progress card with its module filter, one architecture card,
  // one calibration card.
  const whole:Partial<Record<AdminCardId,()=>ReactNode>>={
    progress:()=>progressCard(progress,false),
    catalogue:()=>catalogueCard(),
    calibration:()=><Card className="space-y-4 p-5"><h2 id="calibration" className="font-semibold">{t('calibration')}</h2>{sessions}{groups}</Card>,
  };
  return {
    state,
    card:(id:AdminCardId)=>adminCardShown(id,state)?<div key={id} data-admin-card={id}>{(whole[id]??parts[id as AdminPart])()}</div>:null,
    part:(id:AdminPart)=>adminPartShown(id,state)?<div key={id} data-admin-part={id}>{parts[id]()}</div>:null,
  };
}
