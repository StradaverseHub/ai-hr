/**
 * 5b2a7f0f — `fontkit@1.x` ships no type declarations and needs none here.
 *
 * `lib/payslip-pdf-fonts.ts` imports it for exactly one purpose: to hand it to pdf-lib's
 * `registerFontkit`, which types its own parameter. Nothing in this repo calls a fontkit API directly, so
 * an opaque module declaration says precisely as much as is true. `@types/fontkit` on npm describes the
 * 2.x API, which is NOT the one pdf-lib 1.17.1 drives (see the module docblock), so pulling it in would
 * document the wrong contract.
 */
declare module 'fontkit';
