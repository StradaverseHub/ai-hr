/** Scheduling data only. Every original context runs once; repeated controls add coverage. */
export const WRITE_CONTEXT_PARTITIONS = Object.freeze({
 primary:Object.freeze([0,1,6,10,11,16,20,21]),
 secondary:Object.freeze([3,5,12,14,15,17,19,23]),
 tertiary:Object.freeze([2,4,7,8,9,13,18,22]),
 supplemental:Object.freeze([0,16]),
});
