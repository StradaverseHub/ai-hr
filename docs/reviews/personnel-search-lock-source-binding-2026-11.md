# Personnel search lock source binding

On 6 November 2026 the repository owner approved rebinding the 28 existing AI provider-data approvals to digest `e6d8787efa5cd0051baad6afe5b59cc3c6f27d7b2ff2e3dc03b757e1decec907` in the Personnel hotfix chat. The reviewed source is `eed6fcf3795872db5ad0a8d8be8847ae30a20700`, based on staging source `1e009a82de5bfb2c376bb52d2f235db6ad983229`.

The diff changes Personnel search lock admission, bounded retries, search-token cleanup and the busy response header. Provider contracts, payloads and transport are unchanged. The original review metadata is preserved and both pending records remain pending.

## Deferred company filters

On 6 November 2026 the repository owner approved rebinding the 28 existing records to digest `ff1dfcbe2ded135311303df50e362385914f5ae984b6f3639c132ce652e9edab`. The reviewed source is `c13543badacc0e471b2bf13aaa44d42b40846ed0`. The Personnel list loads filter options on demand and reuses dated hierarchy and label permissions. Provider contracts, payloads, transport, original review metadata and both pending dispositions are preserved.
