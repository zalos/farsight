// The Express pack (PR 15): control facts for routes, from captured source, for exactly Express 4.21.2. Importing
// it parses nothing; the first analysis does.
export { analyzeExpress, EXPRESS_PACK, ExpressPackError } from './pack.js';
export type { ExpressPackInput } from './pack.js';
export { EXPRESS_REASON_CODES } from './model.js';
export type { ExpressReason } from './model.js';
export { matchPath, matchMethod } from './patterns.js';
export type { MatchResult } from './patterns.js';
export { EXPRESS_SUPPORT } from './support.js';
