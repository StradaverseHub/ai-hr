/** Scheduling data only. Every original context runs once; repeated controls add coverage. */
export const WRITE_CONTEXT_PARTITIONS = Object.freeze({
 primary:Object.freeze([0,2,3,5,7,10,11,13,14,16,18,21]),
 secondary:Object.freeze([1,4,6,8,9,12,15,17,19,20,22,23]),
 supplemental:Object.freeze([0,16]),
});
