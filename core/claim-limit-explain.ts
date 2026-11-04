/** AI v2 W5 — "Why is my claim limit what it is, and how much have I used?" from the claims owner's own figures.
 *
 * The input is the balance core/claims.ts getEmployeeClaimTypes (employeeClaimTypesTx) builds for the claim form: the
 * grade-resolved policy's limits, what is held against each of them (pending, approved and paid claims by the date
 * the expense was incurred; drafts hold nothing) and what remains, which the claims owner computed. Nothing is
 * recomputed here: a limit that is not set is reported as not set, never as zero, and every figure is copied across
 * unchanged. The policy version is the resolved claim_policy row's own valid_from. Pure. */
import type {ClaimBalanceRow,ClaimItemBalance} from '../packs/claims/service';

export type ClaimLimitPot=Readonly<{limit:number;used:number;remaining:number|null}>;
export type ClaimLimitExplanation=Readonly<{claimType:string;
 /** True when no limit of any kind applies to this person for this claim type. */
 unlimited:boolean;
 annual:(ClaimLimitPot&Readonly<{pending:number}>)|null;monthly:ClaimLimitPot|null;perClaimCap:number|null;
 lifetime:Readonly<{limit:number;used:number}>|null;block:(ClaimLimitPot&Readonly<{endsOn:string|null}>)|null;
 claimsPerYear:Readonly<{max:number;used:number}>|null;
 items:readonly Readonly<{name:string;annual:ClaimLimitPot|null;monthly:ClaimLimitPot|null;perClaimCap:number|null}>[];
 policy:Readonly<{validFrom:string|null;gradeScoped:boolean}>}>;

const item=(row:ClaimItemBalance)=>({name:row.itemName,
 annual:row.annualLimit===null?null:{limit:row.annualLimit,used:row.usedThisYear,remaining:row.remainingThisYear},
 monthly:row.monthlyLimit===null?null:{limit:row.monthlyLimit,used:row.usedThisMonth,remaining:row.remainingThisMonth},
 perClaimCap:row.perClaimCap});

export function claimLimitExplanation(balance:ClaimBalanceRow):ClaimLimitExplanation{
 const items=balance.items.map(item).filter(row=>row.annual!==null||row.monthly!==null||row.perClaimCap!==null);
 const annual=balance.annualLimit===null?null:{limit:balance.annualLimit,used:balance.usedThisYear,pending:balance.reservedThisYear,remaining:balance.remainingThisYear};
 const monthly=balance.monthlyLimit===null?null:{limit:balance.monthlyLimit,used:balance.usedThisMonth,remaining:balance.remainingThisMonth};
 const lifetime=balance.lifetimeLimit===null?null:{limit:balance.lifetimeLimit,used:balance.usedLifetime};
 const block=balance.blockLimit===null?null:{limit:balance.blockLimit,used:balance.usedThisBlock,remaining:balance.remainingThisBlock,endsOn:balance.blockEndsOn};
 const claimsPerYear=balance.maxClaimsPerYear===null?null:{max:balance.maxClaimsPerYear,used:balance.claimsUsedThisYear};
 return Object.freeze({claimType:balance.typeName,
  unlimited:!annual&&!monthly&&balance.perClaimCap===null&&!lifetime&&!block&&!claimsPerYear&&items.length===0,
  annual,monthly,perClaimCap:balance.perClaimCap,lifetime,block,claimsPerYear,items,
  policy:{validFrom:balance.policyValidFrom??null,gradeScoped:balance.policyGradeScoped===true}});
}
