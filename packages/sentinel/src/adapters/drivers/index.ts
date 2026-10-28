// The production check drivers and the registry definitions they belong to (internal: the trusted execution profile
// and the coordinator are their only callers; nothing here is exported from the package).
export { DRIVER_REASONS, DriverError, fileScope } from './common.js';
export { PATTERN_SUPPORTED_RULES } from './pattern.js';
export { OSV_SUPPORTED_RULES, osvDatabaseId } from './osv.js';
export { TRIVY_SUPPORTED_RULES, TRIVY_CHECKS_DATABASE_ID } from './trivy.js';
export { GITLEAKS_SUPPORTED_RULES } from './gitleaks.js';
export { ZIZMOR_SUPPORTED_RULES } from './zizmor.js';
export type { CheckDriver } from '../../execution/check-drivers.js';

export { productionDrivers, SCANNER_ADAPTER_IDS, SECRETS_ADAPTER_ID } from './canonical.js';
export type { ProductionDriverOptions, DatabaseRecord, ScannerAdapterId } from './canonical.js';
