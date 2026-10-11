import type { StringEntry } from './strings.js';

const same = (word: string, define: string): StringEntry => ({ hud: word, professional: word, define });

export const ECHO_HOOK_STRINGS: Record<string, StringEntry> = {
  'echo.hooks.description': same('Echo session connection', 'Connects a chat to one Echo profile. Memory capture and brief generation are not enabled in this foundation.'),
  'echo.hooks.prepared': same('Prepared for review; hooks are not enabled in the host.', 'The files are ready on this machine. The user must load the plugin and approve any trust request in the host.'),
  'echo.hooks.claude': same('Review the files, then start a new Claude Code session with: {command}', 'Loads the prepared plugin for the new Claude Code session. Existing host settings are not changed.'),
  'echo.hooks.codex': same('Review the files, then register the local marketplace with: {command}\nRestart the desktop app, install the Echo plugin from that marketplace, and review and trust its hooks.', 'Makes the prepared plugin discoverable. Installation and hook trust are separate choices in the host.'),
  'echo.hooks.behavior': same('This foundation binds the host session to this profile. It does not save conversation content, call a model, or add a memory brief.', 'Only the session identity boundary is exercised. Retrieval and capture are future work.'),
  'echo.hooks.singleProfile': same('Enable one Echo profile per host session. Begin a new session when changing personal or work profiles.', 'A session already bound to one identity and store cannot be rebound to another profile.'),
  'echo.hooks.keepPaths': same('Keep this configuration and Echo installation at their current locations. Prepare the hooks again after moving or reinstalling either.', 'The generated runner pins the selected configuration and executable with absolute paths on this machine.'),
  'echo.hooks.invalidHost': same('Choose Claude Code or Codex for hook preparation.', 'Only the two verified host formats are supported.'),
  'echo.hooks.invalidProfile': same('The profile name cannot be used for a hook package.', 'Hook profile names must start with a letter or digit and use only letters, digits, underscores, or hyphens, up to sixty-four characters.'),
  'echo.hooks.absolutePaths': same('Hook preparation requires absolute configuration, installation, and state paths.', 'Absolute paths keep the selected Echo profile independent of the host working folder.'),
  'echo.hooks.missingExecutable': same('Build or install Echo before preparing hooks.', 'The configured Echo executable must exist as a file before a hook can launch it.'),
  'echo.hooks.platform': same('Hook preparation currently supports macOS and Linux.', 'The generated host command uses the shell available on macOS and Linux. Windows hook preparation remains future work.'),
};
