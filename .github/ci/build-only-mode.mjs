/** Minimal explicit build-only mode. Full-gate defaults and actual build steps are unchanged. */
import assert from 'node:assert/strict';
export function withBuildOnlyMode(original){
 assert(typeof original==='string'&&!original.includes('      build_only:'),'Expected original workflow without build-only input');let source=original;
 const replace=(from,to)=>{assert(source.split(from).length===2,'Unique workflow boundary required: '+from);source=source.replace(from,to);};
 replace('      diagnostics_only:', ['      build_only:','        description: Canonical byte build only; never emits a gate PASS','        required: false','        default: false','        type: boolean','      diagnostics_only:'].join('\n'));
 replace("run-name: ${{ inputs.controller_only", "run-name: ${{ inputs.build_only && 'Canonical build only' || inputs.controller_only");
 replace("${{ inputs.diagnostics_only && 'diagnostics' || 'gate' }}", "${{ inputs.build_only && 'build-only' || inputs.diagnostics_only && 'diagnostics' || 'gate' }}");
 replace('      - name: CI integrity regression checks', ['      - name: Refuse invalid build-only execution','        if: ${{ inputs.build_only }}','        env:','          EVENT: ${{ github.event_name }}','          DIAGNOSTICS_ONLY: ${{ inputs.diagnostics_only }}','          CONTROLLER_ONLY: ${{ inputs.controller_only }}','        run: test "$EVENT" = workflow_dispatch && test "$DIAGNOSTICS_ONLY" = false && test "$CONTROLLER_ONLY" = false','      - name: CI integrity regression checks'].join('\n'));
 for(const name of ['typecheck','migrations','controller-tests'])replace('  '+name+':\n    if: ${{ !inputs.diagnostics_only }}','  '+name+':\n    if: ${{ !inputs.diagnostics_only && !inputs.build_only }}');
 replace('    if: ${{ !inputs.diagnostics_only }}\n    needs: resolve\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    defaults:', '    if: ${{ !inputs.diagnostics_only && !inputs.build_only }}\n    needs: resolve\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    defaults:');
 for(const name of ['test','browser'])replace('  '+name+':\n    needs:', '  '+name+':\n    if: ${{ !inputs.diagnostics_only && !inputs.build_only }}\n    needs:');
 replace("if: ${{ always() && !inputs.diagnostics_only && needs.resolve.result == 'success' }}", "if: ${{ always() && !inputs.diagnostics_only && !inputs.build_only && needs.resolve.result == 'success' }}");
 return source;
}
