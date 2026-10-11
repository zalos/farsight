import type { StringEntry } from './strings.js';

const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const ECHO_INSTALLATION_STRINGS: Record<string, StringEntry> = {
  'echo.installation.selection': same('Choose either a settings path or an installation scope: workspace or global.', 'An explicit settings location and an explicit installation scope are alternative ways to select the active memory store.'),
  'echo.installation.workspace': same('Choose an existing workspace folder without a symbolic link at its root.', 'A workspace connection belongs to one existing folder. Its root and private settings directory must be real directories.'),
  'echo.installation.connection': same('The workspace Echo connection is invalid or could not be read. Repair it before continuing.', 'A workspace connection names one absolute settings location and one existing profile. Invalid connections never fall back to a different store.'),
  'echo.installation.profile': same('Choose an Echo profile with a valid name.', 'A profile name starts with a lowercase letter and contains only lowercase letters, digits and hyphens, with a maximum of forty-eight characters.'),
  'echo.installation.changed': same('The workspace Echo connection changed during installation. Retry after the other edit finishes.', 'The original connection is checked again before replacement so a concurrent edit is not silently overwritten.'),
  'echo.installation.readOnly': same('Echo needs permission to write the workspace connection and its backups.', 'The connection and backup directories must allow changes before installation starts. Existing permissions are not changed to bypass this check.'),
  'echo.installation.write': same('The workspace Echo connection could not be saved. Any replaced connection is backed up in this workspace.', 'Connections are written privately and replaced atomically. The original contents are preserved in the local backups directory before replacement.'),
};

export function echoInstallationWord(key: string): string {
  const entry = ECHO_INSTALLATION_STRINGS[key];
  if (!entry) throw new Error(key);
  return entry.professional;
}
