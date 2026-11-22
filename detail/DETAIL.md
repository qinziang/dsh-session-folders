# Conversation Folders

When enabled, a new conversation in a registered workspace gets its own subfolder:

```
<conversation title>-<full session id>
```

Only genuinely new conversations get a folder; existing conversations are not moved retroactively. The folder follows automatic and manual title changes. Archiving the conversation adds the Windows hidden attribute; unarchiving removes it.

## Empty folders

If a turn ends while the folder contains nothing except the `.dsh-session-folder.json` marker (for example, the user only says "hello"), the plugin removes the empty folder and its ASCII junction. When the conversation continues, the folder and junction are recreated during working-directory validation, before the system prompt and tools run, so the working directory never falls back to the workspace root. Any user or generated file keeps the folder after the turn.

## Non-ASCII path compatibility

The session's effective working directory is an ASCII junction under `%PUBLIC%\dsh-session-folders\aliases\<session-id>` that points at the real folder. Node, Python, PowerShell and legacy batch scripts see an ASCII-only path while every file remains in the conversation folder.

## Deleting a conversation

When a conversation is permanently deleted, the plugin stops its registered background jobs, attempts to terminate processes that are still running under the conversation folder or its ASCII junction, removes the junction, and recursively deletes the real folder. Cleanup only runs after both the persisted session record and the workspace membership have disappeared, so a host shutdown or ordinary teardown is never mistaken for a deletion.

## Marker

Each conversation folder contains `.dsh-session-folder.json` with the session id, title, archive state and junction path so the folder can be recovered after a restart.

## License

MIT
