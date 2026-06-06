/**
 * Malaysia statutory payroll calculators (MY localization pack, ADR-0008).
 *
 * ⚠️ RATES ARE APPROXIMATE — for production, replace with the official statutory tables:
 *   - EPF:  the Third Schedule contribution TABLE (not a flat %).
 *   - SOCSO/EIS: the PERKESO contribution BAND tables.
 *   - PCB/MTD: the LHDN Monthly Tax Deduction calculation, which needs the employee's tax
 *     profile (marital status, dependents, reliefs, TP1/TP3). The value here is a SIMPLIFIED
 *     progressive estimate, NOT official MTD. (Compliance sourcing per ADR-0007.)
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** EPF: employee 11%; employer 13% for wages ≤ RM5000, else 12%. */
export function epf(wage: number) {
  return {
    employee: round2(wage * 0.11),
    employer: round2(wage * (wage <= 5000 ? 0.13 : 0.12)),
  };
}

/** SOCSO: ~0.5% employee / 1.75% employer, capped at the RM6000 wage ceiling. */
export function socso(wage: number) {
  const w = Math.min(wage, 6000);
  return { employee: round2(w * 0.005), employer: round2(w * 0.0175) };
}

/** EIS: 0.2% employee / 0.2% employer, capped at the RM6000 ceiling. */
export function eis(wage: number) {
  const w = Math.min(wage, 6000);
  return { employee: round2(w * 0.002), employer: round2(w * 0.002) };
}

/** PCB/MTD — SIMPLIFIED annualised estimate (standard individual relief RM9000). NOT official. */
export function pcb(monthlyGross: number) {
  const chargeable = Math.max(0, monthlyGross * 12 - 9000);
  const brackets: [number, number][] = [
    [5000, 0], [20000, 0.01], [35000, 0.03], [50000, 0.06], [70000, 0.11],
    [100000, 0.19], [400000, 0.25], [600000, 0.26], [2000000, 0.28], [Infinity, 0.3],
  ];
  let tax = 0;
  let prev = 0;
  for (const [cap, rate] of brackets) {
    if (chargeable <= prev) break;
    tax += (Math.min(chargeable, cap) - prev) * rate;
    prev = cap;
  }
  return round2(tax / 12);
}

/** All statutory contributions for a monthly wage. */
export function statutory(wage: number) {
  const e = epf(wage);
  const s = socso(wage);
  const i = eis(wage);
  return {
    epfEmployee: e.employee,
    epfEmployer: e.employer,
    socsoEmployee: s.employee,
    socsoEmployer: s.employer,
    eisEmployee: i.employee,
    eisEmployer: i.employer,
    pcb: pcb(wage),
  };
}
