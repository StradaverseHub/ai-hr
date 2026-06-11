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

### ⛔ The verification gap (why it is not built)

The official **user manual does not contain the byte layout** — field **start positions, widths,
fixed-width vs. delimited, padding, and line terminator**. That spec is a separate, gated LHDN
document (referenced as "Exhibit 4" / "spesifikasi yang ditetapkan oleh LHDNM") not published on
the open web; multiple payroll vendors (SQL, PayrollPanda, Talenox, Kakitangan) implement it but
none publish the byte layout. The physical encoding is **exactly what decides upload acceptance**,
so encoding it from guesswork would produce the rejected-file failure ADR-0010 forbids.

Compounding it: LHDN is **transitioning to e-PCB Plus (2025–2026)**, so the current accepted format
must be reconfirmed against the live portal regardless.

### To build this correctly, we need ONE of

1. The LHDN **"Spesifikasi Format Fail Teks CP39"** byte-layout document (from a registered e-Data
   PCB / e-PCB Plus employer account), **or**
2. A **real sample `.txt`** from a prior successful submission (accountant / existing payroll
   vendor export) to derive the exact encoding, **and**
3. Confirmation of the **e-PCB Plus** current accepted format.

The Layer-A `my.cp39` report (readable PCB figures + CSV, in `localization/my/reports.ts`) already
covers the underlying obligation in the meantime.

---

## 2. EPF / KWSP — Borang A contribution file (i-Akaun)

**Status:** ⬜ Not researched. Source to fetch: KWSP file-layout spec (i-Akaun / e-Caruman).

## 3. SOCSO + EIS — PERKESO ASSIST monthly contribution file

**Status:** ⬜ Not researched. Source to fetch: PERKESO ASSIST Monthly Contribution file format.

## 4. Bank salary-credit (giro) file

**Status:** ⬜ Not researched, and **bank-specific** — needs a named target bank (Maybank M2E /
CIMB BizChannel / Public Bank / RHB / DuitNow-IBG). The ESS bank-account capture (ADR-0012)
provides the employee account data this file consumes.
