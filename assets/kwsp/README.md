# KWSP crest for Borang A and BBCD

Board item 66175cd2 asks for the official KWSP logo at the top left of the
drawn Borang A (KWSP 6) and BBCD. `lib/kwsp-logo.ts` draws it from this file:

    assets/kwsp/kwsp-logo.png

## Where this file comes from (plan revision 2, 26 November 2026)

- Source: the logo KWSP publishes on its own website,
  https://www.kwsp.gov.my/o/kwsp-theme/images/main_logo.png
  (served as WebP, 377 x 180 px, 14,118 bytes, Last-Modified 22 May 2026,
  ETag "8893fcdb", SHA-256
  f501dbcd847b1725f2d9252d73d54dfa9f6d8ea80843e869aac49639928f3ad3).
- Retrieved: 26 November 2026, through a browser (the site's Cloudflare
  protection refuses scripted downloads).
- What was done: the round crest was cropped from the left of that image, up to
  the first fully transparent column before the "KWSP EPF" wordmark, then
  trimmed to its visible pixels. Nothing was traced, redrawn, recoloured or
  resized. It is saved as a non-interlaced RGBA PNG, 182 x 180 px.
- This file's SHA-256:
  a821ed912c0e2f0292696a9f1a7f53444dc4b4109812e1b53346d2e490ae52f6

The vendor reproduction of the crest inside the reporter's reference PDFs is
not used. KWSP's current crest has a plain blue ring; the vendor copy on the
references has lettering in the ring. The forms use KWSP's own current mark.

## Requirements for a replacement

A larger official copy from KWSP can replace this file with no code change:

- An official KWSP file, from KWSP's own published material or supplied by KWSP.
  Update the source, retrieval date and SHA-256 above when you replace it.
- PNG format. RGB or RGBA; a transparent or white background. Not interlaced.
- The shorter side must be at least 180 px. The crest prints about 0.78 inch
  across, so 180 px is about 230 dpi; 600 px or more is better if KWSP offers it.
- Any aspect ratio. The renderers fit the logo into its box and keep its
  proportions, so it is never stretched.

A file that is missing, is not a PNG, or is smaller than 180 px on its shorter
side is not drawn. The server log then says why. Both forms are laid out the
same way with or without the logo. Borang 8A, 8B, SIP and CP39 do not read this
file.
