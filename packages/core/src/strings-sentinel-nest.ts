import type { StringEntry } from './strings.js';

// Sentinel's Nest framework pack (PR 16, ADR 32): why a control fact about a Nest surface is unknown, and which
// registrations the pack met and could not follow. Each key is the stable reason code a control fact or a frontier
// carries. Both registers carry the same words until the PR 09 vocabulary freeze, as in strings-sentinel-plan.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_NEST_STRINGS: Record<string, StringEntry> = {
  // ---- the framework version ----
  'sentinel.nest.versionUnresolved': same('the Nest version could not be resolved exactly', 'The pack reads @nestjs/common and @nestjs/core from the captured lockfile, or an exact pin in the package manifest. A range or a missing entry leaves the version unknown, so every fact for this source is unknown.'),
  'sentinel.nest.versionUnsupported': same('this Nest version is not one the pack supports', 'The pack models the request order of one exact Nest release. Another version may order or apply controls differently, so every fact for this source is unknown.'),
  'sentinel.nest.classValidatorUnsupported': same('the class-validator version is not one the pack supports', 'A ValidationPipe enforces a body schema through class-validator. Its version was not resolved to the one the pack supports, so whether the schema is enforced is unknown.'),
  // ---- the bootstrap and the module graph ----
  'sentinel.nest.bootstrapNotFound': same('no application bootstrap was found', 'The pack starts from one NestFactory.create call. Without it, which modules, controllers and global registrations are live is unknown.'),
  'sentinel.nest.bootstrapAmbiguous': same('more than one application bootstrap was found', 'Several NestFactory.create calls could each start a different application, so which global registrations apply to a controller is unknown.'),
  'sentinel.nest.rootModuleUnresolved': same('the bootstrap\'s root module could not be resolved', 'The module passed to NestFactory.create is not a class declared in the captured source, so the controllers and providers it registers are unknown.'),
  'sentinel.nest.applicationUnresolved': same('the application object could not be followed', 'The created application is not kept in one named variable, so calls that register global guards, pipes, interceptors or middleware on it cannot be found.'),
  'sentinel.nest.moduleUnresolved': same('a module\'s metadata could not be read', 'A module has no @Module decorator with a literal object, so what it imports, registers and provides is unknown.'),
  'sentinel.nest.dynamicModule': same('a dynamic module is not followed', 'A module built at runtime, such as one returned by forRoot or register, can register controllers and global providers the pack cannot see.'),
  'sentinel.nest.externalModule': same('a module from a package or an unresolved import is not followed', 'Only modules declared in the captured source are read. One imported from a package may register global guards, pipes or interceptors the pack cannot see.'),
  'sentinel.nest.unknownFactory': same('a global provider built by a factory, a value or an alias is not followed', 'A guard, pipe or interceptor bound globally through useFactory, useValue or useExisting is decided when the application runs. The pack sees the binding but not what it binds.'),
  'sentinel.nest.nonLiteralRegistration': same('a registration that is not written literally is not followed', 'A spread, a computed list or a variable in a registration could hold anything, so what it registers is unknown.'),
  'sentinel.nest.controllerUnresolved': same('a registered controller could not be resolved', 'A module lists a controller that is not a class declared in the captured source, so its routes and their chains are unknown.'),
  'sentinel.nest.controllerWithoutRoutes': same('a registered controller has no route in the parser graph', 'The module registers this controller, but the parser found no route served by it. Any route it serves is not one of the analysed surfaces.'),
  'sentinel.nest.middlewareNotModeled': same('middleware is not modeled', 'Middleware runs before Nest\'s guards and can refuse, alter or answer a request. The pack does not model what it does, so access-control and validation facts that it could change are unknown.'),
  'sentinel.nest.adapterRouteNotModeled': same('a handler on the HTTP adapter is not modeled', 'A handler mounted directly on the HTTP adapter runs outside Nest\'s guards, interceptors and pipes. It is not one of the controller surfaces the pack analyses.'),
  'sentinel.nest.bootstrapNotInvoked': same('the bootstrap is not called where it certainly runs', 'The function that creates the application is not called unconditionally at the top of its module, so whether any of its registrations take effect is unknown.'),
  'sentinel.nest.applicationEscapes': same('the application is handed to code the pack does not follow', 'The created application is passed to another function or stored elsewhere, where it may receive global guards, pipes or interceptors the pack cannot see.'),
  'sentinel.nest.registrationNotFollowed': same('a global registration that may not run is not counted', 'A global guard, pipe or interceptor is registered conditionally, after the application initialized, after a possible return, in another function or on another object. It is never counted as protection, and it may change any chain, so facts it could change are unknown.'),
  // ---- one surface ----
  'sentinel.nest.surfaceUnresolved': same('the route\'s handler could not be resolved to a controller method', 'The parser graph names this route, but its handler is not a method of a controller class in the captured source, so its chain is unknown.'),
  'sentinel.nest.controllerNotRegistered': same('this controller is not registered by a module the bootstrap reaches', 'Only controllers listed by modules reachable from the root module serve requests. This one is not among them, or the module graph has a frontier, so whether the route is live is unknown.'),
  'sentinel.nest.inheritedController': same('an inherited controller is not followed', 'The controller extends another class, whose decorators, handlers and overrides can change the chain. The pack does not follow inheritance.'),
  'sentinel.nest.customDecorator': same('a custom decorator is not followed', 'A decorator the pack does not know, such as one built with applyDecorators, can register guards, pipes or interceptors, so the chain it is on is unknown.'),
  // ---- what a binding does ----
  'sentinel.nest.guardEffectUnresolved': same('a guard is in the chain, and what it checks is not inferred', 'A guard can refuse a request, but whether it authenticates, authorises or does neither is decided by its code. The pack never infers that from its name or its declaration.'),
  'sentinel.nest.pipeEffectUnresolved': same('a pipe whose effect is not modeled is in the chain', 'Only the framework\'s own ValidationPipe is read as validation. Another pipe, including a local class with the same name, may or may not validate the input.'),
  'sentinel.nest.interceptorEffectUnresolved': same('an interceptor whose effect is not modeled is in the chain', 'An interceptor can answer or refuse a request before its handler runs. The pack does not model this one, so access-control facts it could change are unknown.'),
  'sentinel.nest.validationOptionsUnknown': same('the validation pipe\'s options could not be read', 'A ValidationPipe whose options are not written literally may be configured not to validate, so whether it enforces the schema is unknown.'),
  'sentinel.nest.dtoUnresolved': same('the validated input has no schema the pack can read', 'A ValidationPipe validates against the parameter\'s class. This input\'s type is not a class declared in the captured source, so what is enforced is unknown.'),
  'sentinel.nest.dtoWithoutRules': same('the input\'s class declares no validation rules', 'The parameter\'s class has no class-validator decorators, so a validation pipe over it may accept any value.'),
  'sentinel.nest.dtoConditional': same('the input’s validation rules are conditional', 'A ValidateIf or IsOptional rule, or a rule limited to groups or marked always, decides at run time whether the other rules apply, so whether this input is validated is unknown.'),
  'sentinel.nest.dtoInherited': same('the input’s class inherits rules the pack does not follow', 'The parameter’s class extends another class, whose rules (and conditions on them) also apply. The pack does not follow inheritance.'),
  'sentinel.nest.decoratorMetadataOff': same('the compiler does not emit the type information validation needs', 'ValidationPipe finds a parameter’s class through decorator metadata. The project’s compiler settings turn that metadata off, so the pipe has no class to validate against.'),
  'sentinel.nest.decoratorMetadataUnknown': same('whether the compiler emits the type information validation needs is unknown', 'ValidationPipe finds a parameter’s class through decorator metadata. No captured compiler setting establishes that it is emitted: the setting is inherited, missing, or another compiler builds the project.'),
  // ---- reading the captured files ----
  'sentinel.nest.parseFailed': same('a captured file did not parse', 'A file that does not parse may hold registrations, so the facts they could change are unknown.'),
  'sentinel.nest.invalidUtf8': same('a captured file is not valid UTF-8', 'The pack reads source as UTF-8 text. A file in another encoding is not read, so the facts its registrations could change are unknown.'),
  'sentinel.nest.fileNotRead': same('a captured file was over the pack\'s read limits', 'The pack reads a bounded number of files of a bounded size. A file past the limits may hold registrations, so the facts they could change are unknown.'),
  'sentinel.nest.fileNotCaptured': same('a source file was not captured', 'The snapshot records this file without its bytes. It may hold registrations, so the facts they could change are unknown.'),
  'sentinel.nest.spanUnavailable': same('a registration\'s position could not be recorded', 'Every fact the pack resolves cites the exact bytes that establish it. A registration whose position cannot be converted to a byte span is not used as evidence.'),
};

/** One Nest pack word in the professional register, with `{name}` holes filled. */
export function sentinelNestWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_NEST_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
