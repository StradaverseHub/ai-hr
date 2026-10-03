import {TAX_CIRCUMSTANCE_OPTIONS,taxCircumstanceOf} from './tax-circumstance';
/**
 * MY client-safe pack entry (ADR-0080 rung 5b, D4) — the `CountryPackClient` implementation.
 *
 * PURE DATA + PURE FUNCTIONS ONLY. This file must never import (directly or transitively) db/client,
 * server actions, next-intl/server, or anything 'use client' — it is served to client components by
 * `localization/registry.client.ts`, and one stray server dep here drags the database driver into
 * every client bundle that reads jurisdiction vocabulary. Everything below comes from the pack's
 * existing LEAF modules (ic-dob, leave, bank-files/bnm-codes), which were designed db-free for
 * exactly this trust class.
 *
 * The same object is referenced from the full server pack (`myPack.client` in ./index.ts) so the
 * client vocabulary is contract-declared, not a side channel.
 */
import type { CountryPackClient } from '../country-pack';
import { dobFromIC, isMalaysianNationality } from './ic-dob';
import { entitlement } from './leave';
import { BNM_BANKS } from './bank-files/bnm-codes';
import { defaultSocsoEisNumber } from './socso-eis';
// 04b88724 — THE child-relief derivation, from the same db-free leaf the server pack's
// `childReliefAmountFor` is built on. This is the whole point of putting it in a leaf: the Identification &
// Tax card prices the grid the admin is typing into with the PACK's arithmetic, not a copy of it.
import { childReliefFor } from './child-relief';

export const myClientPack: CountryPackClient = {
  country: 'MY',
  identity: {
    // Item e3ce0d4d / 357faecf — the nationality-conditional NRIC-vs-passport identity fork.
    isLocalNationality: isMalaysianNationality,
    // Item 354a500d — MyKad YYMMDD → DOB (century rule: most-recent-non-future).
    dobFromIC,
  },
  statutory: {
    // 35b7af0a group 7 — the SAME default the Personnel card applies server-side, so the wizard's
    // shared SOCSO/EIS group cannot drift from it. From ./socso-eis, a db-free leaf (see its header).
    defaultSocsoEisNumber,
  },
  leave: {
    // The EA-1955 statutory floor the leave-rule preview shows (same resolver the server engines use).
    entitlement,
  },
  payroll: {
    // Item 04b88724 — the qualifying-children COUNT and the ringgit, as one value, from ONE derivation
    // (./child-relief.ts). The card receives the per-category PRICES as plain props from the server and
    // hands them straight back here with the counts on screen, so the statutory rule never leaves the pack
    // and the screen cannot work out a different figure from the payslip's.
    childReliefFor,
    taxCircumstanceOptions:TAX_CIRCUMSTANCE_OPTIONS,taxCircumstanceOf,
  },
  // Item ef720d3a — canonical MY bank names for the employee bank picker, in BNM catalog order
  // (the four common banks first). Projection of the shared bank master (lib/my-banks via
  // bnm-codes); every name keeps a derivable BNM routing code.
  bankNames: BNM_BANKS.map((b) => b.canonical),
};
