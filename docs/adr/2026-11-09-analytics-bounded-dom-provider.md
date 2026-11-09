# Analytics bounded-page DOM fixture supplies client translations

Source-only fixture repair from `eef89e53102b613bd3cb38fd25dd12fe45d7f9aa`.
The ordinary focused run 42500794548 finished with 25 of 26 assertions passing,
including all 20 database assertions. Its one bounded-page DOM case failed when
the real `ExportDownloadLink` mounted `useExportDownload`, whose three
`useTranslations` calls require the missing client provider.

The application supplies that context through `CatalogClientProvider`, which
renders `NextIntlClientProvider` with the selected locale and actual catalog.
This fixture now supplies the existing English catalog and locale through that
same NextIntl provider, as the existing export-feedback DOM fixture does.
The hook's other dependencies are React state/ref, the plain Sonner toast API
and `exportFilename`; no additional context is required for this render-only
case. No export component, hook, download handler or filename behavior is mocked
or replaced. Existing server translation mocks and UI fixtures remain unchanged.

The sole case name and every original total, row, href, page, filter, manager and
dashboard assertion remain whole; only its render boundary and two imports
change. This addresses a missing test context, not evidence of a production UI
crash or a completed download. After root and independent FULL source review,
the proposed retry is only this one DOM selector/case. Original database passes
remain at EEF/run42500794548, and its failed workflow remains failed. No local
repository behavior, tests, compiler, build or database execution occurred.
