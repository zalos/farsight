import type { StringEntry } from './strings.js';
const example = (text: string): StringEntry => ({ hud: text, professional: text, define: 'Synthetic memory used only by the isolated Echo preview. It is not a fact from a user workspace.' });
export const ECHO_DEMO_STRINGS: Record<string, StringEntry> = {
  'echo.demo.coldTitle': example('Cold shipment: keep the evidence with the decision'),
  'echo.demo.cold': example('Problem: A synthetic medicine shipment needed cold storage. Fix: Use the blue insulated test container and attach the temperature log to the shipment record. Why: The test log made the container decision easy to review later.'),
  'echo.demo.duplicateTitle': example('A retry should not create another dispatch'),
  'echo.demo.duplicate': example('Problem: Retrying a dispatch request created duplicate bookings in a synthetic service. Fix: Store an idempotency key with the first booking and return that result for later retries. Why: A network timeout does not prove that the first request failed.'),
  'echo.demo.buildTitle': example('The release needed a fresh generated manifest'),
  'echo.demo.build': example('Problem: A synthetic release contained yesterday’s generated manifest. Fix: Generate the manifest before packaging, then check the packaged file in the release test. Why: Testing the source file alone did not check the artifact people installed.'),
  'echo.demo.handoffTitle': example('Keep the reason beside the handoff'),
  'echo.demo.handoff': example('Problem: A synthetic team handoff listed a fix without its reason. Fix: Record the problem, concise fix, source link, and the reason for choosing it. Why: The next reader needed enough evidence to judge whether the same fix still applied.'),
  'echo.demo.containerTitle': example('Container trials belong with their source logs'),
  'echo.demo.container': example('Problem: Notes from a synthetic container trial were hard to find. Fix: Save the trial outcome under the shipping and cold-storage topics with its source workspace. Why: Topic labels helped people find related evidence without inventing relationships between records.'),
  'echo.demo.searchTitle': example('An empty search is a reason to refine the question'),
  'echo.demo.search': example('Problem: A synthetic memory search returned no results for a broad question. Fix: Try a narrower phrase and check the selected profile and saved dates. Why: A bounded search is not proof that no related memory exists.'),
};
