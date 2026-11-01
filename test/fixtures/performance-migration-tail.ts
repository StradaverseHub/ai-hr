/** Frozen owned performance append identities. Never compute expected SQL hashes from runtime source. */
export const PERFORMANCE_MIGRATION_TAIL = [
  {
    "idx": 759,
    "version": "7",
    "when": 1793330000279,
    "tag": "0879_claim_history_order",
    "breakpoints": true,
    "hash": "0b3c2b7072e4cee09d37550af1edd855c88ceb5094d122fb1c6032c64e402d3e"
  },
  {
    "idx": 760,
    "version": "7",
    "when": 1793330000280,
    "tag": "0880_visibility_plan_cache",
    "breakpoints": true,
    "hash": "189485ba9146331bf38afa903a7e18f68fb27a3927ceef4a480c876de95165b2"
  },
  {
    "idx": 761,
    "version": "7",
    "when": 1793330000281,
    "tag": "0881_permission_read_work",
    "breakpoints": true,
    "hash": "f828d2414577cf794cf37db0ae72979dc3f5caa1215dd324548bd85acbbfa2d6"
  },
  {
    "idx": 762,
    "version": "7",
    "when": 1793330000282,
    "tag": "0882_session_read_plans",
    "breakpoints": true,
    "hash": "b721eb8da017a5c5b7096f6233a8a83a6bfa155d65465e3d95e440b2d802dc56"
  },
  {
    "idx": 763,
    "version": "7",
    "when": 1793330000283,
    "tag": "0883_home_role_reporting_guard",
    "breakpoints": true,
    "hash": "1d9e2acbc583e86813d3fccbd3596d54acdc8090f9f591489beaee7f0b02998e"
  },
  {
    "idx": 764,
    "version": "7",
    "when": 1793330000284,
    "tag": "0884_visibility_routing_plans",
    "breakpoints": true,
    "hash": "bb48a1477bdc1d60ec86d21d97ff8deb83ad32074fb85ca6a74c9e5860fb9719"
  },
  {
    "idx": 765,
    "version": "7",
    "when": 1793330000285,
    "tag": "0885_attendance_assignment_work",
    "breakpoints": true,
    "hash": "c662c5501c234ba2af0f6c43c242332edcca4c2938bed5422000fdabc3f14158"
  },
  {
    "idx": 766,
    "version": "7",
    "when": 1793330000286,
    "tag": "0886_principal_query_plan",
    "breakpoints": true,
    "hash": "134ca805055e6b0a58b573b18ee3c89fce9bd0c9d574467dcd58f1315229f1b4"
  },
  {
    "idx": 767,
    "version": "7",
    "when": 1793330000287,
    "tag": "0887_attendance_task_candidate_access",
    "breakpoints": true,
    "hash": "31c1c41bae31064505e602b255334983d6f97ee2af0a07810eb645fc83bf00dc"
  },
  {
    "idx": 768,
    "version": "7",
    "when": 1793330000292,
    "tag": "0892_attendance_legacy_candidate_gate",
    "breakpoints": true,
    "hash": "7e667f242c7d7075d4394301ccc43dfe201ecee86ee6e7e046676149df56ca83"
  },
{
  "idx": 769,
  "version": "7",
  "when": 1793330000296,
  "tag": "0896_native_permission_work",
  "breakpoints": true,
  "hash": "a45f6362d2a10b66c14d2be0a4f8199337c7f180bf1d487290cf8ce31fea412e"
},
{
  "idx": 770,
  "version": "7",
  "when": 1793330000297,
  "tag": "0897_administrator_candidate_work",
  "breakpoints": true,
  "hash": "312266b1bf13ca69295776d9bed3beb08ad98a0b8c858da6c213c10919dfb2ae"
},
{
  "idx": 771,
  "version": "7",
  "when": 1793330000300,
  "tag": "0900_attendance_payroll_period_locks",
  "breakpoints": true,
  "hash": "018d4bbfdc1fc0d1b0a4957918e07e206f5a6fca1337d196c0c63fb8940b3fdb"
},
{
  "idx": 772,
  "version": "7",
  "when": 1793330000302,
  "tag": "0902_company_hierarchy_query_plan",
  "breakpoints": true,
  "hash": "7dc2b50fd2289e886737a00fad2a15598ff62b8c066c9e9f384ed23cc7fd77ba"
},
{
  "idx": 773,
  "version": "7",
  "when": 1793330000303,
  "tag": "0903_notice_parent_membership",
  "breakpoints": true,
  "hash": "3f1e29f5724e8e7036360e2ebd7d3576474342000aacf2c907ebc44025e86405"
}
] as const;
