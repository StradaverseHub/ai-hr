/**
 * Hire-form org-picker cascading filter (Admin → Personnel → "Hire an employee").
 *
 * The Hire form's Business Unit / Department / Position / Cost Centre dropdowns must only offer
 * options belonging to the selected hiring Company, so a cross-company combination can never be
 * chosen at the UI level (the server-side `CrossCompanyError` guard in `core/org.ts` stays as the
 * last line of defence for non-JS / direct-POST paths). The Department list additionally keeps the
 * pre-existing BU rule: with a Business Unit chosen, show that BU's departments plus unassigned
 * (NULL-BU) departments; with no BU chosen, show all of the company's departments.
 *
 * Shared System Labels (feedback 570e3311): each option is stamped `data-companies` — the CSV of
 * EVERY company id that may use the label under the resolver (origin ∪ shared-in ∪ global, flag-
 * gated; see core/system-labels.ts labelIdsForCompany) — not just its origin company. So a label
 * shared into company B appears in B's hire lists exactly as configured in System Settings →
 * System Labels. Department options additionally carry `data-bu-companies` — the CSV of companies
 * that may use the department's linked BU: when that BU is NOT usable under the selected company
 * (a shared-in department whose BU stayed origin-only), the BU rule degrades to "unassigned" so
 * the department is not permanently hidden the moment any BU is picked.
 *
 * `hireOptionVisible` is the single pure visibility rule. The page's inline script (kept pure-DOM,
 * no React client island — see the comment in `app/admin/personnel/page.tsx`) embeds this exact
 * function via `HIRE_ORG_FILTER_SCRIPT`, so the unit-tested logic and the shipped script cannot
 * drift. Keep the function body self-contained (no outer-scope references — the csv-contains
 * helper is inlined) — it is serialised with `Function.prototype.toString` into the inline
 * `<script>`.
 */

export interface HireOptionVisibleArgs {
  /**
   * CSV of company ids that may use this option (resolver output); `''` = placeholder ("None" /
   * "Select…") — always visible.
   */
  optCompanies: string;
  /**
   * The option's `data-business-unit` stamp (`''` = unassigned department). Pass `null` for
   * selects without a BU dimension (Business Unit / Position / Cost Centre) to skip the BU rule.
   */
  optBusinessUnit: string | null;
  /**
   * CSV of company ids that may use the department's linked BU (`''` = no linked BU). When the BU
   * is not usable under the selected company, the BU rule degrades to "unassigned" (stays visible).
   */
  optBuCompanies: string;
  /** Currently selected hiring company id (`''` = no company → no company filtering). */
  selectedCompany: string;
  /** Currently selected business unit id (`''` = none chosen → BU rule passes everything). */
  selectedBusinessUnit: string;
}

export function hireOptionVisible(args: HireOptionVisibleArgs): boolean {
  // Inlined csv-contains helper (the body must stay self-contained — it is serialised into the
  // page's inline script via Function.prototype.toString).
  const csvHas = function (csv: string, id: string): boolean {
    if (!csv || !id) return false;
    const parts = csv.split(',');
    for (let i = 0; i < parts.length; i++) if (parts[i] === id) return true;
    return false;
  };
  // Placeholder options ("None"/"Select…" entries carry no data-companies) are always visible.
  if (!args.optCompanies) return true;
  // Company rule: with a company selected, only labels that company MAY use are offered.
  if (args.selectedCompany && !csvHas(args.optCompanies, args.selectedCompany)) return false;
  // BU rule (Department options only; null = the select has no BU dimension): no BU chosen shows
  // everything; unassigned (empty-BU) departments stay visible under every BU choice. A linked BU
  // that is NOT usable under the selected company degrades to unassigned (shared-in department
  // whose BU stayed origin-only must not vanish once any BU is picked).
  if (args.optBusinessUnit === null) return true;
  if (!args.selectedBusinessUnit) return true;
  const effectiveBu =
    args.optBusinessUnit && csvHas(args.optBuCompanies, args.selectedCompany)
      ? args.optBusinessUnit
      : '';
  return effectiveBu === '' || effectiveBu === args.selectedBusinessUnit;
}

/**
 * Inline script for the Hire form: Company → {BU, Department, Position, Cost Centre} cascade,
 * wrapping the original BU → Department cascade. Self-heals stale selections: a selection that
 * became hidden ALWAYS falls back to the '' placeholder option — the Department select now has a
 * disabled "Select a department" placeholder (still `required`, so submit stays blocked until a
 * real pick), which means switching Company CLEARS the previous pick instead of silently
 * auto-picking the new company's first department (Scenario 2 of feedback 570e3311). Options
 * without a `data-companies` stamp (the placeholders) are never re-stamped, so the Department
 * placeholder keeps its markup `disabled` state.
 */
export const HIRE_ORG_FILTER_SCRIPT = `(function(){
  var visible=${hireOptionVisible.toString()};
  var company=document.getElementById('hire-company');
  var bu=document.getElementById('hire-business-unit');
  var dept=document.getElementById('hire-department');
  var pos=document.getElementById('hire-position');
  var cc=document.getElementById('hire-cost-center');
  if(!company||!dept)return;
  function applySelect(sel,useBu){
    if(!sel)return;
    for(var i=0;i<sel.options.length;i++){
      var o=sel.options[i];
      if(!o.getAttribute('data-companies'))continue;
      var show=visible({
        optCompanies:o.getAttribute('data-companies')||'',
        optBusinessUnit:useBu?(o.getAttribute('data-business-unit')||''):null,
        optBuCompanies:o.getAttribute('data-bu-companies')||'',
        selectedCompany:company.value,
        selectedBusinessUnit:useBu&&bu?bu.value:''
      });
      o.hidden=!show;o.disabled=!show;
    }
    var cur=sel.options[sel.selectedIndex];
    if(!cur||cur.hidden){sel.value='';}
  }
  function applyAll(){
    applySelect(bu,false);
    applySelect(dept,true);
    applySelect(pos,false);
    applySelect(cc,false);
  }
  company.addEventListener('change',applyAll);
  if(bu)bu.addEventListener('change',function(){applySelect(dept,true);});
  applyAll();
})();`;
