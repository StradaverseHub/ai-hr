# Field Notes fonts

Manrope (regular, medium, semibold, bold and extra bold) and Newsreader (bold) are bundled from the Expo Google Fonts packages.

Sources are https://github.com/expo/google-fonts/tree/master/font-packages/manrope and https://github.com/expo/google-fonts/tree/master/font-packages/newsreader. The adjacent SIL Open Font Licenses come from Google Fonts' corresponding ofl/manrope and ofl/newsreader directories.

Fonts load locally through expo-font before the mobile navigator mounts. Existing system fallback handles a font-load failure and characters outside a bundled font's coverage.
