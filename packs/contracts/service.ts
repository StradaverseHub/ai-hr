/** Contract Staff module facade. Domain schema and execution stay isolated from legacy onb/off. */
export * from '../../core/contract-management';
// Ordinary Node notification workers consume this facade without loading the
// framework-only builders. Literal imports retain the builders' server boundary.
type ConfigurationService = typeof import('../../core/contract-configuration');
async function loadConfiguration(): Promise<ConfigurationService> {
 const loaded = await import('../../core/contract-configuration');
 return (loaded as { default?: ConfigurationService }).default ?? loaded;
}
export const contractConfigurationWorkflows: ConfigurationService['contractConfigurationWorkflows'] = async (...args) => (await loadConfiguration()).contractConfigurationWorkflows(...args);
export const contractConfigurationDirectory: ConfigurationService['contractConfigurationDirectory'] = async (...args) => (await loadConfiguration()).contractConfigurationDirectory(...args);
export const contractConfigurationTemplates: ConfigurationService['contractConfigurationTemplates'] = async (...args) => (await loadConfiguration()).contractConfigurationTemplates(...args);
