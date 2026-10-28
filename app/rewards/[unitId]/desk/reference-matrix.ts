/** Count changed reference cells against the system default, including newly introduced rows. */
export function changedRewardMatrixCells(matrix:Record<string,readonly number[]>,defaults:Record<string,readonly number[]>){
 return Object.entries(matrix).reduce((count,[key,values])=>count+values.filter((value,index)=>value!==defaults[key]?.[index]).length,0);
}
