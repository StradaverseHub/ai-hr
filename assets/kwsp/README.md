# KWSP logo for Borang A and BBCD (owner-supplied)

Board item 66175cd2 asks for the official KWSP logo at the top left of the
drawn Borang A (KWSP 6) and BBCD. The repository does not ship the logo. The
only copy in hand is a low-resolution reproduction inside another payroll
vendor's printed form, so it is not used, traced or redrawn.

`lib/kwsp-logo.ts` draws the logo only from this file:

    assets/kwsp/kwsp-logo.png

Requirements:

- An official KWSP file, from KWSP's own published material or supplied by KWSP.
  Record its source (URL or sender), the retrieval date and its SHA-256 in this
  README when you add it.
- PNG format. RGB or RGBA; a transparent or white background.
- The shorter side must be at least 300 px. 600 px or more is recommended: the
  logo prints about 0.8 inch across, so 600 px gives about 750 dpi.
- Any aspect ratio. The renderers fit the logo into its box and keep its
  proportions, so it is never stretched.

A file that is missing, is not a PNG, or is smaller than 300 px on its shorter
side is not drawn. The server log then says why. Both forms are laid out the
same way with or without the logo, and the logo box stays blank until the file
is supplied. Borang 8A, 8B, SIP and CP39 do not read this file.
