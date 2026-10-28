// The typed command outcomes moved to app/outcome.ts with the service facade, which returns them; the command line,
// the transports and the service keep importing them from here until each is pointed at app/.
export * from '../app/outcome.js';
