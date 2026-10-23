import type {StringEntry} from './strings.js';
const same=(text:string,define:string):StringEntry=>({hud:text,professional:text,define});
export const SENTINEL_INSTRUCTION_STRINGS:Record<string,StringEntry>={
 'sentinel.review.instructions.visible':same('instructions recorded by Sentinel','The exact instructions, selected skills and included reference text assembled by Sentinel for this review. Hidden instructions supplied by the model vendor are unobserved.'),
 'sentinel.review.instructions.selected':same('selected for this review','These explicitly selected skills were assembled in their recorded order. Sentinel did not discover or activate vendor skills or plugins.'),
 'sentinel.review.instructions.request':same('recorded request','The exact messages Sentinel submitted to its model caller. A prepared request without a settled result has an unknown outcome and is not automatically sent again.'),
 'sentinel.review.instructions.private':same('private review details','Instructions and source messages may contain private information. Retained replay is owner-only and is not a shareable report or proof of a security control.'),
};
