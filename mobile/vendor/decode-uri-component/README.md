# CommonJS distribution of decode-uri-component 0.5.0

The upstream MIT-licensed 0.5.0 fixes
[GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr), but its ESM-only export is
incompatible with `query-string` 7's `require('decode-uri-component')` call in Expo SDK 57.

`index.cjs` is the published 0.5.0 `index.js` with exactly one replacement:
`export default function decodeUriComponent(encodedURI)` becomes
`module.exports = function decodeUriComponent(encodedURI)`.
The decoding algorithm is unchanged. The original MIT license is retained. `provenance.json` records
the public npm tarball and SHA-256 hashes of the tarball, original source and CommonJS distribution.
The mobile lockfile uses a local dependency and an npm override reference so every caller gets it.

FACT: this is a compatibility repack, not an upstream CommonJS release. Tests check its integrity,
the actual query parser and malformed UTF-8 decoding. Remove it when the Expo dependency chain supports
the patched upstream module format; do not upgrade its version without repeating those checks.
