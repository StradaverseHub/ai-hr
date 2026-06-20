# ADR-0031 — Bank salary-disbursement (IBG bulk-payment) files

- **Status:** Proposed (foundation implemented; byte-exact builders gated on go-live inputs)
- **Date:** 2026-06-20
- **Context tags:** payroll, Layer-B, disbursement, Chin Hin go-live, #73 (P-73c)

## Context

Chin Hin Group pays ~4,500 employees across ~60 entities through **four banks: Maybank, CIMB, Public Bank, RHB.** Payroll already emits a neutral payment-summary CSV (`paymentSummaryForBatch`, `core/payroll.ts`) that *explicitly is not* a byte-exact bank file. To actually disburse, each bank needs its own **bulk-payment upload file** in that bank's exact format. Getting a byte or a routing code wrong moves real money to the wrong place, so these are held to the same "source-verbatim, refuse-don't-guess" bar as the statutory files (CP39, SOCSO+EIS).

Formats sourced 2026-06-20 from official/vendor specs (see "Sources"). Confidence and gaps are recorded honestly below — **none of the four is fully byte-verifiable from a populated sample**, and two hard prerequisites are missing from the schema.

## Decision

### 1. Architecture — one IBG core + two adapters

The sourcing established that **CIMB and Public Bank both consume the Malaysian IBG *Autopay* fixed-width layout** (Batch Header `01` / Detail `02` / Trailer `03`; 7-digit BNM code left-justified zero-filled; amounts in cents). Maybank (`Maybank2E-RC`, pipe-delimited, decimal amounts) and RHB (`Reflex BulkPay` CSV / payroll text) wrap the same primitives differently.

→ Build **one `buildIbgAutopayFile()` core** (serves CIMB + Public Bank; they differ only in org-code width and transaction-type token), plus **`buildMaybankRcFile()`** and **`buildRhbBulkPayFile()`** adapters. All reuse the `num`/`alpha`/`cents`/`digits` fixed-width helpers and the readiness-gate + DomainEvent discipline of `cp39-file.ts` / `socso-eis-file.ts`.

### 2. Bank routing — `bnm-codes.ts` map, hard-fail (IMPLEMENTED)

`localization/my/bank-files/bnm-codes.ts` maps a free-text bank name → 2-digit BNM code via exact normalized match, **hard-failing on any unmapped name** (`UnknownBankError`). No fuzzy contains-match (it could mis-route "Public Investment Bank" → Public Bank). `tryBnmCodeForBankName` powers a batch readiness list of every employee whose bank can't be resolved. Golden-tested.

### 3. Schema prerequisites (NOT yet built — block byte-correct output)

1. **Per-employee bank code.** `employeeStatutoryMy` has free-text `bankName` + `bankAccountNo` but no normalized code. The `bnm-codes.ts` map derives the code at file-gen time and hard-fails on unmapped names — acceptable for slice 1. If Chin Hin's imported `bankName` values prove too messy, add an explicit `employeeStatutoryMy.bankCode` column populated at import.
2. **Per-company bank profile (NEW table required).** Every header needs a **bank-issued corporate/organisation ID** and **employer debit account**, per entity per bank — none exist in `companyStatutoryMy` today. With ~60 entities × up to 4 banks this needs its own table:
   `companyBankProfile(companyId, bank, corporateId, debitAccountNo, txnTypeDefault, orgName)`.

### 4. Go-live gate (DRAFT until cleared)

Each generator stays DRAFT until: (a) the **full field spec** is pulled from that bank's corporate portal, (b) one generated file is **diffed byte-for-byte against a known-good file** from that bank, and (c) a **parallel run** confirms the first batch. Same posture as ADR-0010/0024.

## The four formats (sourced field tables)

### Common IBG Autopay (CIMB + Public Bank) — HIGH on layout
Fixed-width, `01`/`02`/`03`. Char = left-justify/space-pad/no `-`/`/`; numeric = leading-zero; **amounts in cents, no decimal point**; BNM code 2-digit left-justified zero-filled to 7 (`35` → `3500000`).
- **Header `01`:** type(2) · org-code(5N, bank-allocated) · org-name(40A) · crediting-date(8N `DDMMYYYY`) · security-code(16N zeros) · filler(2).
- **Detail `02`:** type(2) · BNM-code(7N) · account(16A) · beneficiary-name(40A) · amount(11N cents) · reference(30A → employee code) · beneficiary-id(20A → IC) · txn-type(1N `2`) · **fields 9–10 (unprinted in source — GAP)** · payment-description(20A).
- **Trailer `03`:** type(2) · total-records(6N) · total-amount(13N cents).
- **GAPs:** detail fields 9–10 widths; CIMB org-code is 5-digit, **Public Bank's is 3-char alpha** and its txn-type is **`IBG`/`REN`** (not `2`), filename `[20digits].TXT` — PB layout is MEDIUM confidence and must be pulled from the PB enterprise ECP guide + diffed.

### Maybank2E-RC — HIGH (verbatim spec + sample), but sparse sample
Pipe-delimited (`|`); records `00` header / `01` detail / `99` trailer; **amounts decimal with point** (`18888.30`, opposite of Autopay); payroll payment mode `IG` (IBG). Header: type · Corporate ID · Client Batch ID · fillers. Detail (by pipe position): type · mode(`IG`) · provider-product-group · value-date · customer-ref · debit-ref · debit-desc · currency(`MYR`) · amount(decimal) · in-debit-acct-ccy(`Y`) · debiting-ccy · debiting-account · credit-account · resident-ind · beneficiary-name · new-IC … (fields 23–24, 29–65 = cross-border, blank). **GAP:** the published sample doesn't populate amount/account, and the exact total field count (trailing pipes) isn't pinned — confirm full field list + encoding/EOL/filename + the trailer hashing formula before use.

### RHB Reflex — HIGH (public), two formats
(a) **Payroll fixed-width text** — detail: account(pos 16–29,14) · amount(30–44,15, cents) · name(45–64,40) · IC(65–76,12). (b) **BulkPay CSV** (recommended) — filename `IDENTIFIER_CORPORATEID_DDMMYYYY_NNN.CSV`; amounts `15.2` decimal; records `00`/`10`/`20`/`30`/`99`; header `00`: type · file-identifier(`02`=Payroll) · corporate-id · corporate-name · debit-account · date · batch-no. **GAP:** the `10`/`20`/`30`/`99` per-record column order + the IBG/RENTAS + beneficiary-bank-code columns must be pulled from the logged-in Reflex "File Format" pages.

## Data dependencies (only Chin Hin's banking team can supply)

- The **bank-issued corporate/organisation ID** for each entity at each bank (Maybank Corporate ID; CIMB 5-digit Autopay Org Code; RHB 6-digit Corporate ID; Public Bank 3-char Org Code).
- The **employer debit account** per entity per bank.
- One **known-good sample file** per bank (from the bank or an incumbent payroll tool) to diff against.
- Logged-in **portal spec pulls**: CIMB BizConverter guideline + generated sample; PB enterprise ECP user guide; RHB Reflex file-format record pages.

## Consequences

- Slice 1 (this ADR) ships the **BNM routing map + the architecture + the full sourced spec**, so the build is fully scoped and the sourcing isn't lost. No byte-exact file is emitted yet — correct, given the gaps + missing data.
- Next slice (when the data + portal specs land): the `companyBankProfile` table + admin surface, the IBG-Autopay core + three adapters, golden tests per bank, the per-batch generator + `payroll-batch.bank-file.exported` event, and the byte-diff gate.

## Sources

Maybank2E-RC v4.3 (official, UBS mirror); IBG Autopay bulk-payment spec + BNM code table (UBS Software); CIMB BizConverter Guideline for Bulk Payments v1.2.0.12; RHB Reflex payroll-text + BulkPay-CSV file-format pages; Public Bank ECP format (JustLogin / PayrollPanda vendor KBs; official PB ECP guide is portal-gated); PayNet Interbank GIRO. Full URLs in the 2026-06-20 sourcing record.
