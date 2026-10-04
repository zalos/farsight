// Declarations for workspace.mjs so a spec can import it under the e2e typecheck
// (`allowJs` is off there). Keep in step with the exports in workspace.mjs.
export const REPO_ROOT: string;
export const CLI: string;
export const FIXTURE_REPO: string;
export const STORYBOOK_PORT: number;
export interface FixtureWorkspace { dir: string; graph: string; cleanup: () => void }
export function makeWorkspace(label?: string, opts?: { fixed?: boolean }): FixtureWorkspace;
export function ingest(dir: string, graph: string): void;
export function makeProjectsWorkspace(label?: string): FixtureWorkspace;
