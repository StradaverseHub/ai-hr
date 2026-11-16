/* Proper names on screen (2026-10-22): the page scripts' twin of app.py's proper_name(). HRIS sends job titles,
   departments and unit names in capitals; OneHR keeps them as sent and shows them in proper case. Only text with no
   small letter changes; a word with a digit stays as it is. The short forms are app.py's PROPER_KEEP_UPPER, and
   test_proper_names holds the two lists equal. window.onehrProper(s) -> s in proper case. */
(function () {
  "use strict";
  var KEEP = ("" +
    "AAC ACMV AGM AGT AI ARI ARIT ARIU ASG BG BIM BKG BO BQ BU CAD CEO CFO CHBM CHCE CHGB CHGP CHL CHRO CIO CMO COO CRM " +
    "CSF CSR CTO EHS ELV ER ERP ERT ESG EV FHB FM GBS GCEO GLC GM GMD GP HQ HR HSE HSM HVAC IBS ICT IDP IJM IPC IR IT JKR " +
    "KB KL KLW KPI LMS LRT MD MEP MI MIS MRT OEM OSH PA PAT PBT PIC PMC PMO PP PPC PR QA QAQC QC QMS QS QSHE RTS SAF SAG " +
    "SAP SHE SHEQ SME SOC TNB TSM UI UX ").split(/\s+/), SMALL = "and at by cum for in of on or the to with".split(" "),
      ROMAN = "II III IV IX VI VII VIII XI XII".split(" "), set = {};
  KEEP.concat(ROMAN).forEach(function (w) { if (w) set[w] = 1; });
  window.onehrProper = function (s) {
    if (typeof s !== "string" || !s || /[a-z]/.test(s) || !/[A-Za-z]/.test(s)) return s;
    var first = true;
    return s.replace(/[A-Za-z0-9']+/g, function (w) {
      var out;
      if (/\d/.test(w) || set[w] || w.length === 1) out = w;
      else if (!first && SMALL.indexOf(w.toLowerCase()) >= 0) out = w.toLowerCase();
      else out = w.split("'").map(function (p) { return p.charAt(0) + p.slice(1).toLowerCase(); }).join("'");
      first = false;
      return out;
    });
  };
})();
