import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { LABEL_IMPORT_DEFINITIONS } from '../lib/system-label-definition';
import { buildSystemLabelWorkbook, readSystemLabelWorkbook, systemLabelExportId } from '../lib/system-label-workbook';

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const exportId = '9be541c7-4c42-4073-b454-997832b1284f';
const references = {
  companies: [['Fictional A', 'company-a'], ['Fictional B', 'company-b']],
  employees: [['000007', 'company-a'], ['000008', 'company-b']],
  grades: [['G01', 'Grade one'], ['G02', 'Grade two']],
};
const companyRules = [
  ['A2:A1001', 'Reference!$A$2:$A$3'],
  ['B2:B1001', 'Reference!$C$2:$C$3'],
  ['C2:C1001', 'Reference!$A$2:$A$3'],
];
const expectedRules: Record<string, string[][]> = {
  department: [...companyRules, ['G2:G1001', 'Reference!$E$2:$E$3']],
  position: companyRules,
  cost_center: companyRules,
  business_unit: [...companyRules, ['G2:G1001', 'Reference!$E$2:$E$3']],
  grade_groups: [['B2:B1001', 'Reference!$G$2:$G$3']],
};
const fixtureRow = {
  Company: 'Fictional A', Criteria: 'companies', 'Criteria Companies': 'Fictional A',
  Code: '000123', Name: '000123', Label: 'Fictional label', Description: 'Fictional description',
  'Head Employee Code': '000007', 'Grade Codes': 'G01', 'Sort Order': '7', Rank: '3', Status: 'Active',
};
const elements = (parent: Document | Element, name: string) => Array.from(parent.getElementsByTagNameNS(namespace, name));
function parseXml(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  expect(document.getElementsByTagName('parsererror')).toHaveLength(0);
  return document;
}

describe('System Labels workbook native worksheet structure', () => {
  it.each([false, true])('omits empty validation containers and preserves list features (populated export: %s)', async populated => {
    const kinds = LABEL_IMPORT_DEFINITIONS.map(definition => definition.kind);
    expect(kinds).toHaveLength(14);
    const bytes = await buildSystemLabelWorkbook({
      references, kinds,
      ...(populated ? {
        rows: Object.fromEntries(kinds.map(kind => [kind, [fixtureRow]])),
        includeStatus: true, exportId,
      } : {}),
    });
    const zip = await JSZip.loadAsync(bytes);
    const workbook = XLSX.read(bytes, { type: 'buffer', cellNF: true });
    const workbookXml = parseXml(await zip.file('xl/workbook.xml')!.async('string'));
    const sheets = elements(workbookXml, 'sheet');
    expect(workbook.SheetNames).toEqual(['Instructions', ...kinds, 'Reference', ...(populated ? ['_Export'] : [])]);
    let totalRules = 0;
    let listsWithoutRules = 0;
    for (const definition of LABEL_IMPORT_DEFINITIONS) {
      const index = workbook.SheetNames.indexOf(definition.kind);
      const document = parseXml(await zip.file(`xl/worksheets/sheet${index + 1}.xml`)!.async('string'));
      const containers = elements(document, 'dataValidations');
      const rules = elements(document, 'dataValidation');
      const expected = expectedRules[definition.kind] ?? [];
      // CT_DataValidations requires at least one child. Omit this optional container otherwise.
      // https://github.com/dotnet/Open-XML-SDK/blob/main/data/schemas/schemas_openxmlformats_org_spreadsheetml_2006_main.json
      expect(containers, definition.kind).toHaveLength(expected.length ? 1 : 0);
      expect(rules, definition.kind).toHaveLength(expected.length);
      if (!expected.length) listsWithoutRules++;
      else expect(containers[0].getAttribute('count')).toBe(String(expected.length));
      expect(rules.map(rule => ({
        range: rule.getAttribute('sqref'), formula: elements(rule, 'formula1')[0]?.textContent,
        type: rule.getAttribute('type'), blank: rule.getAttribute('allowBlank'), error: rule.getAttribute('showErrorMessage'),
      }))).toEqual(expected.map(([range, reference]) => ({
        range, formula: `INDIRECT("${reference}")`, type: 'list', blank: '1', error: '0',
      })));
      totalRules += rules.length;
      const lastColumn = XLSX.utils.encode_col(definition.columns.length - (populated ? 0 : 1));
      expect(elements(document, 'autoFilter').map(filter => filter.getAttribute('ref'))).toEqual([`A1:${lastColumn}${populated ? 2 : 1}`]);
      expect(elements(document, 'pane').map(pane => ({
        state: pane.getAttribute('state'), split: pane.getAttribute('ySplit'), start: pane.getAttribute('topLeftCell'),
      }))).toEqual([{ state: 'frozen', split: '1', start: 'A2' }]);
      const codeColumn = definition.columns.indexOf(definition.kind === 'grade_groups' ? 'Name' : 'Code');
      const address = `${XLSX.utils.encode_col(codeColumn)}2`;
      expect(elements(document, 'c').find(cell => cell.getAttribute('r') === address)?.getAttribute('s')).toBe('1');
      if (populated) expect(workbook.Sheets[definition.kind][address]).toMatchObject({ v: '000123', t: 's', z: '@' });
    }
    expect(listsWithoutRules).toBe(9);
    expect(totalRules).toBe(15);
    expect(readSystemLabelWorkbook(bytes)).toHaveLength(populated ? 14 : 0);
    expect(systemLabelExportId(bytes)).toBe(populated ? exportId : null);
    expect(sheets.filter(sheet => sheet.getAttribute('state') === 'veryHidden').map(sheet => sheet.getAttribute('name')))
      .toEqual(populated ? ['_Export'] : []);
  // Building and parsing 14 native worksheets is CPU work; the full gate runs other files too.
  }, 20000);
});
