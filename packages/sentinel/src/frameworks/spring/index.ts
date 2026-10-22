// The Spring Security servlet framework pack (PR 17): control facts for routes, from captured source, for exactly
// Spring Boot 3.4.3 with Spring Security 6.4.3. Importing it loads no grammar; the first analysis does.
export { analyzeSpring, SPRING_PACK, SPRING_ORDER, SpringPackError } from './pack.js';
export type { SpringPackInput } from './pack.js';
export { SPRING_REASON_CODES } from './config.js';
export type { SpringReason } from './config.js';
export { matchTemplate } from './patterns.js';
export type { MatchResult } from './patterns.js';
export { SPRING_SUPPORT } from './support.js';
