// Genuine owner adoption/pack promotion and a held facade; no synthetic receipt or successful publication.
import { join } from 'node:path';
import { initWorkspace } from '../../dist/cli/init.js';
import { workspaceOf, adoptWorkspaceSettings, promoteRulePack } from '../../dist/service/local.js';
import { builtinPackDir } from '../../dist/service/package-paths.js';
import { publicRegistry } from '../../dist/service/scanner-profile.js';
import { commitRepo, openCaptureStore, scratch } from '../snapshot-helpers.ts';
export async function preparationFixture(t: any, pack = 'foundation-preview') {
  const dir = scratch(t),
    root = join(dir, 'workspace');
  commitRepo(root, { 'src/one.ts': 'export const one=1;' });
  const ws = workspaceOf(root, { ...process.env, XDG_STATE_HOME: join(dir, 'owner') });
  initWorkspace({ workspace: root, ...(pack === 'foundation-preview' ? {} : { profile: pack }) });
  if (adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome !== 'prepared')
    throw new Error('fixture adoption failed');
  if (promoteRulePack(ws, { packDir: builtinPackDir(pack)!, confirm: true, now: new Date() }).outcome !== 'prepared')
    throw new Error('fixture promotion failed');
  const { store } = await openCaptureStore(t, dir, ws.storePath);
  return { dir, ws, store, registry: publicRegistry(ws.trustDir) };
}
