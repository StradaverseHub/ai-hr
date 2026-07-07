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
 * `hireOptionVisible` is the single pure visibility rule. The page's inline script (kept pure-DOM,
 * no React client island — see the comment in `app/admin/personnel/page.tsx`) embeds this exact
 * function via `HIRE_ORG_FILTER_SCRIPT`, so the unit-tested logic and the shipped script cannot
 * drift. Keep the function body self-contained (no outer-scope references) — it is serialised with
 * `Function.prototype.toString` into the inline `<script>`.
 */

export interface HireOptionVisibleArgs {
  /** The option's `data-company` stamp; `''` = placeholder ("None") — always visible. */
  optCompany: string;
  /**
   * The option's `data-business-unit` stamp (`''` = unassigned department). Pass `null` for
   * selects without a BU dimension (Business Unit / Position / Cost Centre) to skip the BU rule.
   */
  optBusinessUnit: string | null;
  /** Currently selected hiring company id (`''` = no company → no company filtering). */
  selectedCompany: string;
  /** Currently selected business unit id (`''` = none chosen → BU rule passes everything). */
  selectedBusinessUnit: string;
}

export function hireOptionVisible(args: HireOptionVisibleArgs): boolean {
  // Placeholder options ("None" entries carry no data-company) are always visible.
  if (!args.optCompany) return true;
  // Company rule: with a company selected, only that company's options are offered.
  if (args.selectedCompany && args.optCompany !== args.selectedCompany) return false;
  // BU rule (Department options only; null = the select has no BU dimension): no BU chosen shows
  // everything; unassigned (empty-BU) departments stay visible under every BU choice.
  if (args.optBusinessUnit === null) return true;
  return (
    !args.selectedBusinessUnit ||
    args.optBusinessUnit === '' ||
    args.optBusinessUnit === args.selectedBusinessUnit
  );
}

/**
 * Inline script for the Hire form: Company → {BU, Department, Position, Cost Centre} cascade,
 * wrapping the original BU → Department cascade. Self-heals stale selections: a required select
 * (Department) falls back to its first visible option; optional selects (BU / Position / Cost
 * Centre) fall back to their empty "None" placeholder.
 */
export const HIRE_ORG_FILTER_SCRIPT = `(function(){
  var visible=${hireOptionVisible.toString()};
  var company=document.getElementById('hire-company');
  var bu=document.getElementById('hire-business-unit');
  var dept=document.getElementById('hire-department');
  var pos=document.getElementById('hire-position');
  var cc=document.getElementById('hire-cost-center');
  if(!company||!dept)return;
  function applySelect(sel,useBu,required){
    if(!sel)return;
    var firstVisible=null;
    for(var i=0;i<sel.options.length;i++){
      var o=sel.options[i];
      var show=visible({
        optCompany:o.getAttribute('data-company')||'',
        optBusinessUnit:useBu?(o.getAttribute('data-business-unit')||''):null,
        selectedCompany:company.value,
        selectedBusinessUnit:useBu&&bu?bu.value:''
      });
      o.hidden=!show;o.disabled=!show;
      if(show&&firstVisible===null)firstVisible=o;
    }
    var cur=sel.options[sel.selectedIndex];
    if(!cur||cur.hidden){sel.value=required?(firstVisible?firstVisible.value:''):'';}
  }
  function applyAll(){
    applySelect(bu,false,false);
    applySelect(dept,true,true);
    applySelect(pos,false,false);
    applySelect(cc,false,false);
  }
  company.addEventListener('change',applyAll);
  if(bu)bu.addEventListener('change',function(){applySelect(dept,true,true);});
  applyAll();
})();`;
