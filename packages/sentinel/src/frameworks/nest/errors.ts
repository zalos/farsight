// Nest pack reason codes. Every code is a catalog key in packages/core/src/strings-sentinel-nest.ts; a test pins
// this list against the catalog.
import { sentinelNestWord } from '@farsight/core/dist/strings-sentinel-nest.js';
import { SentinelError } from '../../kernel/errors.js';

/** Why a fact is unknown, or which registration the pack could not follow. Recorded, never thrown. */
export const NEST_REASON_CODES = Object.freeze([
  'sentinel.nest.versionUnresolved',
  'sentinel.nest.versionUnsupported',
  'sentinel.nest.classValidatorUnsupported',
  'sentinel.nest.bootstrapNotFound',
  'sentinel.nest.bootstrapAmbiguous',
  'sentinel.nest.rootModuleUnresolved',
  'sentinel.nest.applicationUnresolved',
  'sentinel.nest.moduleUnresolved',
  'sentinel.nest.dynamicModule',
  'sentinel.nest.externalModule',
  'sentinel.nest.unknownFactory',
  'sentinel.nest.nonLiteralRegistration',
  'sentinel.nest.controllerUnresolved',
  'sentinel.nest.controllerWithoutRoutes',
  'sentinel.nest.middlewareNotModeled',
  'sentinel.nest.adapterRouteNotModeled',
  'sentinel.nest.bootstrapNotInvoked',
  'sentinel.nest.applicationEscapes',
  'sentinel.nest.registrationNotFollowed',
  'sentinel.nest.applicationMutated',
  'sentinel.nest.frameworkMutated',
  'sentinel.nest.frameworkEscapes',
  'sentinel.nest.surfaceUnresolved',
  'sentinel.nest.controllerNotRegistered',
  'sentinel.nest.inheritedController',
  'sentinel.nest.customDecorator',
  'sentinel.nest.guardEffectUnresolved',
  'sentinel.nest.pipeEffectUnresolved',
  'sentinel.nest.interceptorEffectUnresolved',
  'sentinel.nest.validationOptionsUnknown',
  'sentinel.nest.dtoUnresolved',
  'sentinel.nest.dtoWithoutRules',
  'sentinel.nest.dtoConditional',
  'sentinel.nest.dtoInherited',
  'sentinel.nest.decoratorMetadataOff',
  'sentinel.nest.decoratorMetadataUnknown',
  'sentinel.nest.parseFailed',
  'sentinel.nest.invalidUtf8',
  'sentinel.nest.fileNotRead',
  'sentinel.nest.fileNotCaptured',
  'sentinel.nest.spanUnavailable',
] as const);
/** One of {@link NEST_REASON_CODES}. */
export type NestReasonCode = (typeof NEST_REASON_CODES)[number];
/** A reason code without its `sentinel.nest.` prefix. */
export type NestReason = NestReasonCode extends `sentinel.nest.${infer C}` ? C : never;

/** The words for a reason code, in the professional register. */
export function nestReasonWord(code: NestReasonCode): string {
  return sentinelNestWord(code);
}

/**
 * The analysis produced an envelope that does not validate: a defect in the pack, never a property of the source.
 * Its code is the contract's `sentinel.contract.invalid`.
 */
export class NestPackError extends SentinelError<'sentinel.contract.invalid'> {
  constructor(detail: string) {
    super('sentinel.contract.invalid', `the Nest pack's control facts do not validate: ${detail}`);
    this.name = 'NestPackError';
  }
}
