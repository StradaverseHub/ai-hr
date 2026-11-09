import { getLocale, getTranslations } from 'next-intl/server';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  analyticsBreakdownGroups, analyticsMonthBand, analyticsMonthBands, analyticsPerformance, analyticsPositions,
  analyticsRatio, analyticsTalent, averageIncreaseAndCr, bonusMetrics, payPositionMetrics, rangePosition, salaryMetrics,
} from '@/packs/rewards/analytics-model';
import { renderRewardSetupPdf } from '@/packs/rewards/setup-pdf';
import { makeWorkbook } from '@/packs/rewards/setup-workbook';
import { loadRewardsAnalytics } from '../report';

export const runtime = 'nodejs';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
const exportKeys = new Set(['format', 'digest', 'view', 'basis', 'breakdown', 'group', 'review', 'unit', 'company', 'cycle', 'uploaded']);

export async function GET(request: Request) {
  const fail = (message: string, status: number) => new Response(message, { status, headers: privateHeaders });
  if (request.url.length > 2400) return fail('Invalid export request.', 400);
  const query = new URL(request.url).searchParams;
  if ([...query].some(([key]) => !exportKeys.has(key) || query.getAll(key).length !== 1)) {
    return fail('Invalid export request.', 400);
  }
  const format = query.get('format');
  const digest = query.get('digest');
  if ((format !== 'pdf' && format !== 'xlsx') || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
    return fail('Invalid export request.', 400);
  }

  let report: Awaited<ReturnType<typeof loadRewardsAnalytics>>;
  try {
    report = await loadRewardsAnalytics(query);
  } catch {
    return fail('Rewards Analytics export is unavailable.', 403);
  }
  const selected = new Map(report.selected.map(unit => [unit.id, unit]));
  if (!selected.size || !report.rows.length) return fail('Rewards Analytics export is unavailable.', 403);
  if (!report.reconciled || report.digest !== digest || report.rows.some(row => !selected.has(row.unitId))) {
    return fail('Figures are being refreshed. Reload Rewards Analytics before exporting.', 409);
  }

  try {
    const basis = report.filters.basis;
    const view = report.filters.view;
    const date = todayInKualaLumpur();
    const multiplier = basis === 'annual' ? 12 : 1;
    const salary = (cents: number | null) => cents === null ? null : cents * multiplier / 100;
    const cycles = [...new Set(report.selected.map(unit => unit.cycle))].join(', ');
    const title = view === 'salary' ? 'Salary before and after' : 'Bonus payout';

    let bytes: Uint8Array;
    if (format === 'xlsx') {
      bytes = makeWorkbook(report.rows.map(row => {
        const unit = selected.get(row.unitId)!;
        const scope = {
          'Report date': date, View: title, 'Salary basis': basis, Cycle: unit.cycle, Company: unit.company,
          'Business unit': unit.unit, 'Employee code': row.employeeCode, Name: row.name, 'Job grade': row.grade,
          Department: row.department?.name ?? '', Talent: row.talent ?? '', Performance: row.performance ?? '',
        };
        if (view === 'salary') {
          return {
            ...scope, 'Basic before (MYR)': salary(row.beforeCents), 'Basic after (MYR)': salary(row.afterCents),
            'Merit (MYR)': salary(row.meritCents), 'Promotion (MYR)': salary(row.promotionCents),
            'Special adjustment (MYR)': salary(row.specialCents), 'In increment run': row.incrementRun,
          };
        }
        return {
          ...scope, 'Bonus eligible': row.bonusEligible, 'Bonus basic (MYR)': salary(row.bonusBasicCents),
          'Bonus (MYR, cycle payout)': row.bonusCents / 100, 'Lump sum (MYR, cycle payout)': row.lumpCents / 100,
          'Bonus months': row.bonusBasicCents === null ? null : analyticsRatio(row.bonusCents, row.bonusBasicCents),
          ...(unit.canSeePat ? { 'PAT achievement (%)': unit.patAchievement === null ? null : unit.patAchievement * 100 } : {}),
        };
      }));
    } else {
      const [locale, analyticsText, nav] = await Promise.all([
        getLocale(), getTranslations('rewardsAnalytics'), getTranslations('nav'),
      ]);
      const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' });
      const rate = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
      const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
      const pay = (cents: number) => money.format(cents * multiplier / 100);
      const payout = (cents: number) => money.format(cents / 100);
      const asRate = (n: number | null) => n === null ? '—' : rate.format(n);
      const asValue = (n: number | null) => n === null ? '—' : value.format(n);
      const totals = report.totals;
      const lines = [
        'Date · ' + date,
        'Cycle · ' + cycles,
        'Salary basis · ' + basis + (view === 'bonus' ? ' · Bonus figures are cycle payouts' : ''),
        'Scope · ' + report.selected.map(unit => unit.company + ' / ' + unit.unit).join(' · '),
        '',
      ];
      if (report.protectedIncluded) lines.push('Summary totals include protected staff. Breakdown figures cover the visible rows.');
      if (report.protectedWithheld) lines.push('Some results are withheld to protect staff confidentiality.');
      if (view === 'salary') {
        lines.push(
          'Payroll before · ' + pay(totals.beforeCents), 'Payroll after · ' + pay(totals.afterCents),
          'Increase · ' + pay(totals.afterCents - totals.beforeCents),
          'People with an increase · ' + totals.increased + ' / ' + totals.people, '',
        );
        const position = payPositionMetrics(report.rows);
        lines.push('Pay range positions · Below / Within / Above / No range');
        lines.push('Before · ' + Object.values(position.before).join(' / '), 'After · ' + Object.values(position.after).join(' / '), '');
      } else {
        const metrics = bonusMetrics(report.rows);
        lines.push(
          'Bonus payout · ' + payout(totals.bonusCents + totals.lumpCents),
          'People paid · ' + totals.paid + ' / ' + totals.eligible,
          'Visible bonus months · Median ' + asValue(metrics.medianMonths) + ' · Average ' + asValue(metrics.averageMonths),
          'Bonus as a share of annual basic · ' + asRate(analyticsRatio(totals.eligibleBonusCents, totals.eligibleAnnualBasicCents)), '',
        );
      }
      if (view === 'salary') {
        const inRun = report.rows.filter(row => row.incrementRun);
        const grades = [...new Set(inRun.map(row => row.grade))].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
        for (const [dimension, labels] of [['grade', grades], ['talent', analyticsTalent]] as const) {
          lines.push('Average increase by ' + dimension + ' · Below / Within / Above before the increase');
          for (const label of labels) {
            const rows = inRun.filter(row => row[dimension] === label);
            if (!rows.length) continue;
            const cells = analyticsPositions.map(position => {
              const metric = averageIncreaseAndCr(rows.filter(row => rangePosition(row.beforeCents, row.beforeRange) === position));
              return asRate(metric.increase) + ' (CR ' + asValue(metric.afterCr) + ', ' + metric.count + ')';
            });
            lines.push(label + ' · ' + cells.join(' / '));
          }
          lines.push('');
        }
      } else {
        const eligibleRows = report.rows.filter(row => row.bonusEligible);
        const grades = [...new Set(eligibleRows.map(row => row.grade))].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
        lines.push('Bonus months by grade and performance · ' + analyticsPerformance.join(' / '));
        for (const grade of grades) {
          const rows = eligibleRows.filter(row => row.grade === grade);
          const cells = analyticsPerformance.map(performance => asValue(bonusMetrics(rows.filter(row => row.performance === performance)).averageMonths));
          lines.push(grade + ' · ' + cells.join(' / ') + ' · Bonus share of pay mix ' + asRate(bonusMetrics(rows).payMix));
        }
        lines.push('', 'Bonus months distribution · ' + analyticsMonthBands.map(band => band + ': ' +
          eligibleRows.filter(row => analyticsMonthBand(row) === band).length).join(' · '), '');
        lines.push('Pool utilisation by unit');
        for (const unit of report.selected) {
          const rows = report.rows.filter(row => row.unitId === unit.id && row.pooled);
          const bonus = bonusMetrics(rows);
          const utilisation = unit.poolCents === null ? null : analyticsRatio(bonus.payout, unit.poolCents);
          const pat = unit.canSeePat && unit.patAchievement !== null ? ' · PAT achievement ' + asRate(unit.patAchievement) : '';
          lines.push(unit.company + ' / ' + unit.unit + ' · ' + asRate(utilisation) + pat);
        }
        lines.push('');
      }
      lines.push('Breakdown · ' + report.filters.breakdown);
      for (const group of analyticsBreakdownGroups(report.rows, report.selected, report.filters.breakdown)) {
        const { rows } = group;
        const label = group.label || analyticsText('unavailable');
        if (view === 'salary') {
          const m = salaryMetrics(rows);
          lines.push(label + ' · ' + m.people + ' people · ' + pay(m.beforeCents) + ' → ' + pay(m.afterCents) +
            ' · Increase ' + asRate(m.increaseRate) + ' · Median compa ratio ' + asValue(m.medianBeforeCr) + ' → ' + asValue(m.medianAfterCr));
        } else {
          const m = bonusMetrics(rows);
          lines.push(label + ' · Paid ' + m.paid + ' / ' + m.eligible + ' · ' + payout(m.payout) +
            ' · Average months ' + asValue(m.averageMonths) + ' · Median ' + asValue(m.medianMonths) + ' · Highest ' + asValue(m.highestMonths));
        }
      }
      const viewName = analyticsText(view);
      bytes = await renderRewardSetupPdf(nav('rewardsAnalytics') + ' · ' + viewName, lines);
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...privateHeaders,
        'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="rewards-analytics-' + view + '-' + date + '.' + format + '"',
      },
    });
  } catch {
    return fail('Rewards Analytics export is unavailable.', 500);
  }
}
