import type { EmailLinkError } from '@/lib/email-body/doc';

/** Every visible string of EmailBodyEditor. English defaults; {name} placeholders are filled by formatLabel. */
export type EmailBodyEditorLabels = {
  editor: string; toolbar: string; bold: string; italic: string; underline: string; link: string; bulletList: string; orderedList: string;
  table: string; image: string; insertField: string; undo: string; redo: string; close: string; cancel: string; apply: string; applyAnyway: string;
  linkTitle: string; textToShow: string; linkTo: string; linkWeb: string; linkMailto: string; linkDocument: string; webAddress: string; emailAddress: string;
  document: string; chooseDocument: string; noDocuments: string; insecure: string; linkErrors: Record<EmailLinkError, string>;
  linkActions: string; linkTarget: string; openLink: string; editLink: string; removeLink: string; documentLinkTarget: string;
  tableTitle: string; tableSize: string; tableHint: string; tablePhone: string; tableToolbar: string; cellPosition: string;
  rowAbove: string; rowBelow: string; columnLeft: string; columnRight: string; deleteRow: string; deleteColumn: string; headerRow: string;
  widths: string; widthFit: string; widthEqual: string; deleteTable: string;
  blockedDeleteHeader: string; blockedLastRow: string; blockedLastColumn: string; blockedRowAboveHeader: string; rowLimit: string; columnLimit: string; tablePlacement: string;
  imageTitle: string; noImages: string; imageCellLimit: string; noAlt: string;
  fieldTitle: string; fieldSearch: string; noFields: string; fieldChip: string;
  pasteTruncated: string; pasteImages: string; pasteTooLarge: string;
};

export const defaultEmailBodyEditorLabels: EmailBodyEditorLabels = {
  editor: 'Email body', toolbar: 'Formatting', bold: 'Bold', italic: 'Italic', underline: 'Underline', link: 'Link', bulletList: 'Bulleted list', orderedList: 'Numbered list',
  table: 'Table', image: 'Image', insertField: 'Insert field', undo: 'Undo', redo: 'Redo', close: 'Close', cancel: 'Cancel', apply: 'Apply', applyAnyway: 'Apply anyway',
  linkTitle: 'Link', textToShow: 'Text to show', linkTo: 'Link to', linkWeb: 'Web address', linkMailto: 'Email address', linkDocument: 'Document in this email',
  webAddress: 'Web address', emailAddress: 'Email address', document: 'Document', chooseDocument: 'Choose a document',
  noDocuments: 'No documents can be linked from this email.',
  insecure: 'This address starts with http:// and is not secure. Use https:// if the site supports it.',
  linkErrors: {
    empty: 'Enter an address.', length: 'The address is longer than 2,000 characters.', spaces: 'The address cannot contain spaces.',
    field: 'Fields cannot be used in a link address.', scheme: 'Only web (https:// or http://) and email addresses can be linked.',
    domain: 'Enter a full web address, for example https://www.example.com.', credentials: 'The address cannot contain a user name or password.',
    email: 'Enter a full email address, for example name@example.com.', document: 'Choose a document from this email.', kind: 'Choose what to link to.',
  },
  linkActions: 'Link', linkTarget: 'Links to {target}', openLink: 'Open', editLink: 'Edit', removeLink: 'Remove', documentLinkTarget: '{name} (each person gets their own link)',
  tableTitle: 'Insert table', tableSize: '{columns} columns × {rows} rows', tableHint: 'The first row is the header row.',
  tablePhone: 'Tables with 5 or more columns are hard to read on phones.', tableToolbar: 'Table', cellPosition: 'Row {row}, column {column}',
  rowAbove: 'Row above', rowBelow: 'Row below', columnLeft: 'Column left', columnRight: 'Column right', deleteRow: 'Delete row', deleteColumn: 'Delete column',
  headerRow: 'Header row', widths: 'Widths', widthFit: 'Fit content', widthEqual: 'Equal', deleteTable: 'Delete table',
  blockedDeleteHeader: 'The header row cannot be deleted. Turn Header row off instead.', blockedLastRow: 'This is the last row. Use Delete table instead.',
  blockedLastColumn: 'This is the last column. Use Delete table instead.', blockedRowAboveHeader: 'A row cannot be added above the header row.',
  rowLimit: 'A table can have up to 30 rows.', columnLimit: 'A table can have up to 6 columns.', tablePlacement: 'A table cannot go inside another table or a list.',
  imageTitle: 'Insert image', noImages: 'Upload an image under Images used in the body first.', imageCellLimit: 'A table cell can hold one image.', noAlt: 'No alt text',
  fieldTitle: 'Insert field', fieldSearch: 'Search fields', noFields: 'No matching fields.', fieldChip: '{label} (field)',
  pasteTruncated: 'The pasted table was larger than 6 columns × 30 rows. Only the first 6 columns and 30 rows were kept.',
  pasteImages: 'Pasted images were removed. Upload images under Images used in the body, then use Image.',
  pasteTooLarge: 'That is too much content to paste at once.',
};

export const formatLabel = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
