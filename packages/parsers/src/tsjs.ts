// Farsight's legacy test-file default is retained; standalone parsing has an explicit file-selection option.
import { ingestTsJs as extractTsJs, tsJsAdapter as adapter } from '@farsight/code-parser/adapters/tsjs';
import type { IngestOptions } from './types.js';
export { SQL_DRIVERS, storeLike } from '@farsight/code-parser/adapters/tsjs';
export function ingestTsJs(root: string, options: IngestOptions = {}) {
  return extractTsJs(root, { ...options, testFiles: options.testFiles ?? (options.tests === false ? 'include' : 'exclude') });
}
export const tsJsAdapter = Object.freeze({ ...adapter, async ingest(root: string, options: IngestOptions = {}) { return ingestTsJs(root, options); } });
