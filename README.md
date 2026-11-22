# dsh-session-folders

A DSH host plugin that gives every new conversation its own folder inside the selected workspace.

## Features

- **New conversation folder**: creates `<conversation-title>-<session-id>` (initially `新对话-<session-id>`). Existing conversations are not moved retroactively.
- **Title sync**: renames the folder in place when DSH generates or the user edits the conversation title.
- **Archive / unarchive**: hides the folder with the Windows hidden attribute on archive and removes the attribute on unarchive.
- **Delete cleanup**: stops the session's background jobs and matching processes, removes the ASCII junction, and recursively deletes the conversation folder after the session is permanently deleted.
- **Empty-turn cleanup**: if a turn ends with no user files (only the `.dsh-session-folder.json` marker), removes the empty folder and its junction; the next turn recreates both during working-directory validation, before the system prompt and tools run. A folder containing any file is kept.
- **Non-ASCII path compatibility**: the session's effective working directory is an ASCII junction under `%PUBLIC%\dsh-session-folders\aliases\<session-id>` pointing at the real folder. Node, Python, PowerShell, and legacy batch scripts see an ASCII-only path while all files remain in the real conversation folder.

## Install

Install this directory as a DSH bundle (`dsh.bundle.patch` points to `cordis.patch.yml`) and restart or reload the profile. The plugin is Host-only and has no client UI.

## Requirements

- DSH with Cordis 4
- Node.js `^22.15.0 || >=24.0.0`
- Windows recommended for the hidden-attribute and junction behavior; the folder logic still runs on other platforms with directory symlinks.

## Notes

- Only genuinely new conversations get a folder. Conversations created before installing the plugin are not migrated.
- The folder is named after the current conversation title; invalid Windows filename characters are replaced and long titles are truncated.
- The ASCII junction is an implementation detail. Files always live in the real folder inside the workspace.

## License

MIT
