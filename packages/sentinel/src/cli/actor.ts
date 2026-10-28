// Who asks moved to app/actor.ts beside the facade's principals (app/principal.ts); the command line, the transports
// and the service keep importing it from here until each is pointed at app/.
export * from '../app/actor.js';
