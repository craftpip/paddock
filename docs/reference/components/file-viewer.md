# File Viewer

`src/client/src/components/FileViewer.jsx` is the app's one file viewer and editor. It began as
the Workspace tab's modal and is now shared: the Workspace tab opens workspace files in it, and
the Mission queue opens plan files in it. The caller says where the file lives; the component
owns how it is shown and edited.

## Contract

```jsx
<FileViewer
  source={{
    key,          // stable identity of the file; the draft key is `file:<key>`
    name,         // shown while loading
    subtitle,     // optional second line (Mission: project · plans/<path>)
    downloadUrl,  // optional; shows a Download link
    load: async () => ({ name, content, size, size_hr, revision, media, mediaUrl }),
    save: async (content, loaded) => ({ revision, size }),  // omit for read-only
  }}
  identity={(location) => '…'}  // equal while this file stays open
  onClose={…}
  onError={(message) => …}       // optional
/>
```

| Behaviour | Rule |
|---|---|
| Unsaved edits | Kept as a navigation draft (`drafts`, key `file:<source.key>`), so a reload restores them; leaving the file while dirty asks "Discard changes?" through `useDirtyNavigation` with the caller's `identity` |
| Save | Button or Ctrl/Cmd+S. A response that arrives after a newer edit, or after another file was opened, changes nothing |
| `.json` | Parsed before saving; a parse error is shown with its line and nothing is written |
| Refusals | A rejected save shows its message above the editor and keeps the text. A refusal whose `code` ends in `_conflict` also offers **Reload**, which asks before replacing unsaved edits |
| Read-only | No `save`, binary content (a NUL in the first 4 KiB), or a failed load |
| Media | `media: 'image' \| 'video'` with `mediaUrl` renders the media instead of text |

Hooks: `file-viewer` (panel), `file-viewer-name`, `file-viewer-state`, `file-viewer-save`,
`file-viewer-close`, `file-viewer-editor`, `file-viewer-problem`, `file-viewer-reload`. The
editor keeps `id="file-editor"`.

## Callers

- **Workspace tab** (`pages/agent/WorkspaceTab.jsx`): popup `file:<path>`, load through
  `GET /api/agents/:name/workspace/file` (media revalidated through the listing), save through
  `POST /api/agents/:name/workspace/save`, Download through `…/workspace/download`.
- **Mission queue** (`components/QueuePanel.jsx`): clicking a queue row's title/path
  (`msn-queue-item-open`) opens popup `plan-file:<runnerId>:<path>`. Load and save go through
  `GET` / `PUT /api/mission/runners/:id/plan-file`, see
  [Mission Queue and Runner](../backend/mission-queue.md#plan-file).

## See Also

- [URL navigation](navigation.md) — popups, drafts and the dirty-navigation guard
- [Mission Page](../pages/mission.md#queue-panel)
