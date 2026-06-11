# Malaysia Agency File Formats (Layer-B) — Sources & Verification

**Scope:** byte-exact **submission files** for agency portals (ADR-0010 §6D, "Layer-B").
**Sibling doc:** [STATUTORY-SOURCES.md](STATUTORY-SOURCES.md) (the statutory *figures*).

> ⚠️ **Layer-B posture (ADR-0010).** A submission file that the portal **rejects** — or that
> remits the **wrong** contribution — is worse than the readable Layer-A report keyed in by hand.
> Every format here ships **"DRAFT — not for submission"** until an accountant verifies the
> generated file against the live portal (or against a real sample file). Build per a concrete
> target, never speculatively. None of the formats below is built yet.

---

## 1. CP39 — MTD / PCB text file (LHDN, `e-Data PCB` → `e-PCB Plus`)

**Status:** 🟡 **Structure sourced; physical byte-encoding BLOCKED — not built.**

### What is authoritatively sourced

- **Source:** LHDN — _Manual Pengguna: Aplikasi e-Data PCB_ (official user manual),
  <https://eapps.hasil.gov.my> (manual PDF retrieved Jun 2026). Portal: <https://eapps.hasil.gov.my/>.
- The CP39 text file is an upload to **e-Data PCB** (for computerised payroll), now being folded
  into **e-PCB Plus** via MyTax. The portal also accepts **manual key-in** (e-CP39) — so the file
  is a convenience/bulk feature, **not a legal requirement** (ADR-0010 §6D).
- **Record structure** (from the manual's parsed-data screens, §2.7): the file is grouped into one
  or more **group blocks**, each = one **header** ("Kepala Kelompok") + N **employee detail**
  records ("Rekod Data Pekerja").

  **Group header fields** (sample values from the manual):
  | Field | Sample |
  |---|---|
  | No. E (Ibu Pejabat) — employer E-no., HQ | `9018598010` |
  | No. E (Cawangan) — employer E-no., branch | `9018598010` |
  | Bulan/Tahun Potongan — deduction month/year | `8/2006` |
  | Jumlah amaun PCB — total PCB | `RM 51.00` |
  | Jumlah rekod pekerja — PCB record count | `1` |
  | Jumlah amaun CP38 — total CP38 | `RM 0.00` |
  | Jumlah rekod CP38 — CP38 record count | `0` |

  **Employee detail fields** (sample values):
  | Field | Sample |
  |---|---|
  | No. Rujukan Cukai — tax ref / TIN | `11785370040` |
  | Nama — name | `LIEW SIEW MUN` |
  | No. KP Lama — old IC | _(blank)_ |
  | No. KP Baru — new IC | `790124085587` |
  | No. Passport | _(blank)_ |
  | Kod Negara — country code | _(blank)_ |
  | Amaun PCB | `RM 51.00` |
  | Amaun CP38 | `RM 0.00` |
  | No. Pekerja — employee no. | _(blank)_ |

- **Validation rules observed** (manual §2.7, Lampiran 1): header totals must reconcile to the sum
  of detail records (the validator reports the "Perbezaan" / difference between Kepala Kelompok and
  Rekod Transaksi); amounts must be numeric ("Amaun CP38 Bukan Numerik"); the file reference number
  must be valid ("Nombor Rujukan Fail Tidak Sah"); a record cannot be all-blank ("Rekod hanya
  mempunyai ruang kosong"); the branch E-number must match the registered employer.
- **File naming** (from manual screenshots): `<E-number>_<year>.txt`, e.g. `029409640001_2010.txt`.

### ✅ UNBLOCKED (2026-06-11): the byte layout is published — Exhibit 4 of the MTD spec

The "gated" layout was hiding in plain sight: **Exhibit 4 — "Specification Format for MTD Text
File Data"** of the official LHDN _Specification for MTD Calculations Using Computerized
Calculation for 2026_ (the same PDF our PCB figures come from):
<https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf>
(pp. 43–44, incl. a worked sample file). §E.18 states the system "must provide the text file data
format (Exhibit 4) for the purpose of MTD submission", uploaded via e-Data PCB / **e-PCB Plus**.

**Filename:** `<employerNo(10)><mm>_<yyyy>.txt`

**Header record — fixed-width, 57 chars:**

| # | Field | Pos | Len | Type | Rule |
|---|---|---|---|---|---|
| 1 | Record type | 1 | 1 | A | literal `H` |
| 2 | Employer no. (HQ) | 2–11 | 10 | N | E-number digits only, right-justify, zero-pad (E 908915-10 → `0090891510`) |
| 3 | Employer no. | 12–21 | 10 | N | as above |
| 4 | Year of deduction | 22–25 | 4 | N | `YYYY` |
| 5 | Month of deduction | 26–27 | 2 | N | `MM` |
| 6 | Total MTD amount | 28–37 | 10 | N | cents, no decimal point, zero-padded (RM8,350.00 → `0000835000`) |
| 7 | Total MTD records | 38–42 | 5 | N | zero-padded |
| 8 | Total CP38 amount | 43–52 | 10 | N | as field 6 |
| 9 | Total CP38 records | 53–57 | 5 | N | zero-padded |

**Detail record — fixed-width, 136 chars:**

| # | Field | Pos | Len | Type | Rule |
|---|---|---|---|---|---|
| 10 | Record type | 1 | 1 | A | literal `D` |
| 11 | TIN | 2–12 | 11 | N | **mandatory**; digits without "IG", zero-padded to 11 (IG 531367080 → `00531367080`) |
| 12 | Employee name | 13–72 | 60 | A | left-justify, space-pad |
| 13 | Old IC no. | 73–84 | 12 | A/N | blank if n/a |
| 14 | New IC no. | 85–96 | 12 | N | digits, no dashes; blank if n/a |
| 15 | Passport no. | 97–108 | 12 | A/N | left-justify; blank if n/a |
| 16 | Country code | 109–110 | 2 | A | foreigners only |
| 17 | MTD amount | 111–118 | 8 | N | cents, no decimal point, zero-padded (RM900.00 → `00090000`) |
| 18 | CP38 amount | 119–126 | 8 | N | as above |
| 19 | Employee no. | 127–136 | 10 | A/N | left-justify |

**Still required before "not for submission" comes off a generated file:** confirmation against
the live **e-PCB Plus** portal (the migration is in progress) and an accountant's verification of
one real upload — the standard Layer-B sign-off. The Layer-A `my.cp39` report continues to cover
the obligation meanwhile. A DRAFT generator can now be built sourced, not guessed.

---

## 2. EPF / KWSP — Borang A contribution (i-Akaun e-Caruman)

**Status:** 🟡 **Known to be CSV; exact columns behind a 403 — not built.**

- e-Caruman (i-Akaun) accepts a **CSV** upload (plus a legacy fixed `EPFORMA.TXT`). CSV is
  column-based and far less byte-sensitive than the fixed-width agency files.
- **Source (gated):** KWSP _Easy Guide — Preparing CSV File for e-Caruman_ and _Quick Guide — CSV
  Prepare Data (eVE)_, on <https://www.kwsp.gov.my>. The KWSP site returns **HTTP 403** to
  programmatic fetches, so the exact column list/order wasn't retrievable here.
- **To build:** the KWSP CSV column spec (manual download by a logged-in employer) or a real
  sample `.csv`. Once the columns are known this is the **most tractable** of the four (CSV, no
  byte positions to verify).

## 3. SOCSO + EIS — PERKESO ASSIST combined contribution file

**Status:** 🟢 **Record layout SOURCED & testable; 🟡 combined-amount semantic open (needs a sample).**

- **Source (primary):** PERKESO official **text-file structure spec** (xlsx),
  <https://www.perkeso.gov.my/images/text_file_format.xlsx> ("Text File Structure (NEW)"),
  cross-checked against the PERKESO _User Manual: SOCSO + EIS Contribution & Payment (External
  User)_ v1.0, 22 Jul 2022,
  <https://www.perkeso.gov.my/images/panduan/280722_-_User_Manual_-_Combine_Contribution__Payment_-_External_User_v1.pdf>
  (retrieved Jun 2026).
- Uploaded under **ASSIST → Contribution → SOCSO + EIS** (the 2022 "combined" upload; other
  formats are rejected with "invalid text file format"). Filename pattern `SOCSO_EIS_MMYYYY.txt`.
- **Record layout — FIXED-WIDTH, 223 chars/record** (verbatim from the official spec):

  | # | Field | Len | Pos | Type | Mand | Justify / notes |
  |---|---|---|---|---|---|---|
  | 1 | Employer Code | 12 | 1–12 | A/N | Y | left; check-digit |
  | 2 | MyCoID / SSM Number | 20 | 13–32 | A/N | N | left; ROB/ROC |
  | 3 | ID Number | 12 | 33–44 | A/N | Y | left; new/old IC, military/police/SSN |
  | 4 | Employee Name | 150 | 45–194 | A/N | Y | left |
  | 5 | Month Contribution | 6 | 195–200 | Num | Y | `MMYYYY` |
  | 6 | Contribution Amount | 14 | 201–214 | Num | Y | right; **cents, no decimal point** |
  | 7 | Employment Date | 8 | 215–222 | Num | Y | `DDMMYYYY` (join/resign/death in the month) |
  | 8 | Employment Status | 1 | 223 | A/N | N | `B` new · `H` resigned · `M` deceased · `S` sick-leave-on-benefit · `T` unpaid leave |

  (Same structure as the legacy eCapai system.)
- **⚠️ Open semantic (the verify-point):** the structure has **one** "Contribution Amount" and
  **no scheme field**, yet ASSIST's post-upload summary breaks the file into **SOCSO** and **EIS**
  (employer + employee shares) separately. So how the combined file encodes both schemes — one
  record per employee with the combined total, vs. two records (SOCSO, then EIS) — is **not
  deducible from the spec alone**, and the spec's "Text File Sample" sheet is empty. A single real
  sample `.txt` resolves it. Until then a generated file risks the **wrong contribution split** —
  not shipped (ADR-0010, "a wrong contribution is worse than none").
- Also needs a sample to fix: the **Employment Date** value when there's no join/resign event in
  the month, and the exact **numeric padding** (zero- vs space-fill) of the amount.

## 4. Bank salary-credit (giro) file

**Status:** ⬜ Not built — **bank-specific**, needs a named target bank (Maybank M2E / CIMB
BizChannel / Public Bank / RHB / DuitNow-IBG), each with its own bulk-payment spec (generally
gated to account holders). The ESS bank-account capture (ADR-0012) supplies the employee account
data this file consumes.

---

## Conclusion (research, Jun 2026)

Empirically, **none of the four Layer-B formats is fully buildable-correct from public sources**:
CP39's byte layout is gated; KWSP's CSV guide is 403; PERKESO's record layout is sourced but its
combined-amount semantic needs a sample; bank is vendor-specific. This **confirms ADR-0010 §6D** —
build per a concrete target with a **real sample file** (or the gated spec), not speculatively. The
fastest unblock for any one of these is a single real sample from the customer's accountant or
current payroll vendor; the generator is then built to match and **verified against the sample**.
