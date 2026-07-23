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

export const myClientPack: CountryPackClient = {
  country: 'MY',
  identity: {
    // Item e3ce0d4d / 357faecf — the nationality-conditional NRIC-vs-passport identity fork.
    isLocalNationality: isMalaysianNationality,
    // Item 354a500d — MyKad YYMMDD → DOB (century rule: most-recent-non-future).
    dobFromIC,
  },
  leave: {
    // The EA-1955 statutory floor the leave-rule preview shows (same resolver the server engines use).
    entitlement,
  },
  // Item ef720d3a — canonical MY bank names for the employee bank picker, in BNM catalog order
  // (the four common banks first). Projection of the shared bank master (lib/my-banks via
  // bnm-codes); every name keeps a derivable BNM routing code.
  bankNames: BNM_BANKS.map((b) => b.canonical),
};
