import type { StringEntry } from './strings.js';

const same = (word: string, define: string): StringEntry => ({ hud: word, professional: word, define });

export const ECHO_HOOK_STRINGS: Record<string, StringEntry> = {
  'echo.hooks.description': same('Echo memory connection', 'Connects a chat to one Echo profile and retrieves bounded context from its existing memories.'),
  'echo.hooks.prepared': same('Prepared for review; hooks are not enabled in the host.', 'The files are ready on this machine. The user must load the plugin and approve any trust request in the host.'),
  'echo.hooks.claude': same('Review the files, then start a new Claude Code session with: {command}', 'Loads the prepared plugin for the new Claude Code session. Existing host settings are not changed.'),
  'echo.hooks.codex': same('Review the files, then register the local marketplace with: {command}\nRestart the desktop app, install the Echo plugin from that marketplace, and review and trust its hooks.', 'Makes the prepared plugin discoverable. Installation and hook trust are separate choices in the host.'),
  'echo.hooks.behavior': same('Hooks connect the session to this profile and retrieve matching saved memories for a prompt. They do not save conversation content or call a model. Automatic capture and model summaries are future work.', 'Session and prompt events can supply bounded memory context. Other events maintain the session identity boundary without capturing content.'),
  'echo.hooks.singleProfile': same('Enable one Echo profile per host session. Begin a new session when changing personal or work profiles.', 'A session already bound to one identity and store cannot be rebound to another profile.'),
  'echo.hooks.keepPaths': same('Keep this configuration and Echo installation at their current locations. Prepare the hooks again after moving or reinstalling either.', 'The generated runner pins the selected configuration and executable with absolute paths on this machine.'),
  'echo.hooks.invalidHost': same('Choose Claude Code, Codex, or VS Code for hooks.', 'The three supported hosts use their own verified command-hook formats.'),
  'echo.hooks.vscode': same('Review echo.json, then install it as .github/hooks/echo.json in the workspace. Use VS Code’s Local agent in a trusted workspace.', 'VS Code Local discovers workspace command hooks. Agent Host is a separate host and is not supported by these hooks.'),
  'echo.hooks.installed': same('Workspace hook files are installed. Start a new host session to load them.', 'The selected workspace files now contain Echo commands pinned to this configuration and installation.'),
  'echo.hooks.installedClaude': same('Claude Code: start a new session in this workspace and review the hooks in /hooks.', 'Claude Code reads command hooks from the workspace .claude/settings.local.json file.'),
  'echo.hooks.installedCodex': same('Codex: open this workspace, enable hooks if needed, then use /hooks to review and trust these exact hook definitions.', 'Installing .codex/hooks.json does not enable the Codex feature or grant hook trust. The user grants trust in the host.'),
  'echo.hooks.installedVscode': same('VS Code: reopen the workspace, trust it if prompted, and use the Local agent. Check the agent’s hook diagnostics to confirm Echo is loaded.', 'Native workspace hooks apply to VS Code Local. They do not activate the separate Agent Host.'),
  'echo.hooks.workspaceInvalid': same('Choose an existing workspace folder with an installed Echo command.', 'The workspace and executable must be existing absolute paths; symbolic hook destinations are refused.'),
  'echo.hooks.workspaceMalformed': same('An existing hook or editor settings file could not be safely updated. Repair its structure and try again.', 'Hook files must contain unambiguous JSON objects and hook arrays. Existing editor settings may use JSON comments and trailing commas.'),
  'echo.hooks.workspaceChanged': same('A hook file changed during installation. Retry after the other edit finishes.', 'The installer checks the original file before replacing it to avoid overwriting concurrent changes.'),
  'echo.hooks.workspaceWrite': same('Echo could not finish writing the workspace hooks. Original files are backed up beside the Echo settings.', 'Existing files are copied into the private backups directory before an atomic replacement; unchanged files are not rewritten.'),
  'echo.hooks.vscodeDuplicate': same('VS Code is configured to load Claude hooks too. Turn off chat.useClaudeHooks for this workspace before installing both native VS Code and Claude hooks.', 'Loading both hook sources would inject the same Echo memory twice. The installer leaves editor preferences unchanged.'),
  'echo.hooks.invalidProfile': same('The profile name cannot be used for a hook package.', 'Hook profile names must start with a letter or digit and use only letters, digits, underscores, or hyphens, up to sixty-four characters.'),
  'echo.hooks.absolutePaths': same('Hook preparation requires absolute configuration, installation, and state paths.', 'Absolute paths keep the selected Echo profile independent of the host working folder.'),
  'echo.hooks.missingExecutable': same('Build or install Echo before preparing hooks.', 'The configured Echo executable must exist as a file before a hook can launch it.'),
  'echo.hooks.platform': same('Hook preparation currently supports macOS and Linux.', 'The generated host command uses the shell available on macOS and Linux. Windows hook preparation remains future work.'),
};
