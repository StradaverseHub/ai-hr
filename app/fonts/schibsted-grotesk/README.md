# Schibsted Grotesk

Unmodified normal variable TrueType face from the official Google Fonts repository,
commit `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5`:

- [Original font](https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/schibstedgrotesk/SchibstedGrotesk%5Bwght%5D.ttf), saved as `SchibstedGrotesk-Variable.ttf`; 176,068 bytes, SHA256 `6ceeadf6be8e1fd7687011c7fa38ed0edd1abe967a0b73d97caec183552e823d`.
- [Original license](https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/schibstedgrotesk/OFL.txt), copied unchanged as `OFL.txt`; 4,406 bytes, SHA256 `3b4f3063b6ac7c1e403e2c4a5e8ef3a58190ff83ed7b15af66511858699139ce`.

Copyright 2023 The Schibsted-Grotesk Project Authors
(https://github.com/schibsted/schibsted-grotesk). Licensed under SIL Open Font
License 1.1; see the adjacent full license.

The file identifies itself as Schibsted Grotesk Regular, version 1.100, with 583
glyphs and a `wght` axis from 400 to 900. The layout retains only its previous
400/500/600 normal face declarations, `--font-schibsted`, swap display and preload.
The full upstream character coverage is retained; no subsetting or conversion was
performed. Other fonts and the shared non-Latin fallback chain are unchanged.

Local loading avoids the variable Google CSS response whose extensionless
`/l/font?kit=…&skey=…&v=…` sources fail Next 16.3's query/extension parsing. This
removes Schibsted's build-time network dependency; the other three Google font
imports still use their existing loader.
