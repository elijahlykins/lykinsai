# Repository Usage Audit (2026-02-24)

## Scope and Method
- Source-of-truth file list: `git ls-files` (tracked files only).
- Usage detection: static import graph from `src/main.jsx` + `server.js` for production; `youtubeQa.test.js` for test-only.
- Status `UNUSED CANDIDATE` means no static path from active entrypoints. Dynamic/runtime loading could still exist.

## Project Structure
```text
lib/
public/
src/
src/api/
src/assets/
src/canvas/
src/canvas/blockSystem/
src/canvas/blockSystem/__tests__/
src/canvas/blockSystem/ai/
src/canvas/blockSystem/runtime/
src/canvas/blocks/
src/canvas/blocks/universal/
src/canvas/utils/
src/components/
src/components/files/
src/components/notes/
src/components/ui/
src/hooks/
src/lib/
src/omnia/
src/pages/
src/pages/api/ai/
src/pages/new/
src/store/
src/utils/
supabase-migrations/
```

## Empty Files
- src/App.css
- src/api/entities.js
- src/api/integrations.js
- src/components/notes/AutoArchive.jsx
- src/components/notes/ChatPanel.jsx
- src/components/notes/SearchModal.jsx
- src/globals.css
- src/pages/AISearch.jsx
- src/pages/LongTerm.jsx

## Unused Candidate Count
- 99 files flagged as unused candidates

## Full File-by-File List
| File | Status | Used by (examples) | Purpose |
|---|---|---|---|
| .gitignore | USED (tooling/runtime) |  | Git ignore rules |
| DEPLOYMENT.md | DOCS (not runtime) |  | Documentation |
| IMPLEMENTATION_GUIDE.md | DOCS (not runtime) |  | Documentation |
| QUICK_START.md | DOCS (not runtime) |  | Documentation |
| README.md | DOCS (not runtime) |  | Documentation |
| SOCIAL_INTEGRATIONS_README.md | DOCS (not runtime) |  | Documentation |
| STORAGE_SETUP.md | DOCS (not runtime) |  | Documentation |
| SUPABASE_SCHEMA.md | DOCS (not runtime) |  | Documentation |
| components.json | USED MANUALLY (shadcn generator) |  | shadcn/ui generator config |
| eslint.config.js | USED (tooling/runtime) |  | ESLint configuration |
| index.html | USED (tooling/runtime) |  | Vite HTML shell with #root mount |
| jsconfig.json | USED (tooling/runtime) |  | Path aliases / TS config for editor + typecheck |
| lib/supabase.js | CHECK NEEDED |  | Non-src support library |
| package-lock.json | USED (tooling/runtime) |  | Lockfile for reproducible installs |
| package.json | USED (tooling/runtime) |  | NPM scripts and dependency manifest |
| postcss.config.js | USED (tooling/runtime) |  | PostCSS configuration |
| public/manifest.json | CHECK NEEDED (not imported) |  | Static file served from /public |
| restart-server.ps1 | USED MANUALLY |  | Manual PowerShell helper script |
| server.js | USED (tooling/runtime) |  | Express backend server |
| src/App.css | USED (prod graph) | src/App.jsx | Frontend source file |
| src/App.jsx | USED (prod graph) | src/main.jsx | Top-level router and providers |
| src/api/base44Client.js | UNUSED CANDIDATE (only in orphan graph) | src/lib/AuthContext.jsx, src/lib/NavigationTracker.jsx | Frontend API helper |
| src/api/entities.js | UNUSED CANDIDATE (no refs) |  | Frontend API helper |
| src/api/integrations.js | UNUSED CANDIDATE (no refs) |  | Frontend API helper |
| src/assets/Colored.jpg | USED (prod graph) | src/pages/Dashboard.tsx | Image asset |
| src/assets/Gradient Glow You’ll Want to Keep Staring At.jpg | UNUSED CANDIDATE (no refs) |  | Image asset |
| src/assets/Maybe.jpg | USED (prod graph) | src/pages/Dashboard.tsx, src/pages/new/MemoryNew.jsx | Image asset |
| src/assets/Yes.jpg | UNUSED CANDIDATE (no refs) |  | Image asset |
| src/assets/download (26).jpg | UNUSED CANDIDATE (no refs) |  | Image asset |
| src/assets/react.svg | UNUSED CANDIDATE (no refs) |  | Image asset |
| src/canvas/Canvas.tsx | USED (prod graph) | src/pages/OmniaCanvas.tsx | Canvas system module |
| src/canvas/SlashCommandMenu.tsx | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/__tests__/connections.smoke.ts | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/__tests__/definitions.smoke.ts | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/__tests__/planner.smoke.ts | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/ai/actionComposer.ts | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blockSystem/__tests__/planner.smoke.ts | Canvas system module |
| src/canvas/blockSystem/ai/systemPlanner.ts | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blockSystem/__tests__/planner.smoke.ts, src/canvas/blockSystem/ai/actionComposer.ts | Canvas system module |
| src/canvas/blockSystem/connections.ts | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blockSystem/__tests__/connections.smoke.ts, src/canvas/blockSystem/runtime/connectionEngine.ts | Canvas system module |
| src/canvas/blockSystem/definitions.ts | USED (prod graph) | src/canvas/blockSystem/__tests__/definitions.smoke.ts, src/canvas/blockSystem/connections.ts, src/canvas/blockSystem/notionModel.ts | Canvas system module |
| src/canvas/blockSystem/notionModel.ts | USED (prod graph) | src/canvas/blockSystem/definitions.ts, src/pages/OmniaCanvas.tsx | Canvas system module |
| src/canvas/blockSystem/renderRegistry.tsx | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/runtime/connectionEngine.ts | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/runtime/dataResolver.ts | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blockSystem/runtime/connectionEngine.ts | Canvas system module |
| src/canvas/blockSystem/runtime/eventBus.ts | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blockSystem/runtime/connectionEngine.ts | Canvas system module |
| src/canvas/blockSystem/runtime/logicEngine.ts | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/runtime/policyEngine.ts | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blockSystem/types.ts | USED (prod graph) | src/canvas/blockSystem/ai/actionComposer.ts, src/canvas/blockSystem/connections.ts, src/canvas/blockSystem/definitions.ts | Canvas system module |
| src/canvas/blocks/CodeBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/CreateBlock.tsx | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blocks/DesignBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/FileBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/ImageBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/LinkBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/ListBlock.tsx | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blocks/SheetBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/SpreadsheetBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/TaskBoardBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/TextBlock.tsx | UNUSED CANDIDATE (no refs) |  | Canvas system module |
| src/canvas/blocks/YouTubeBlock.tsx | USED (prod graph) | src/canvas/Canvas.tsx, src/canvas/blocks/CreateBlock.tsx | Canvas system module |
| src/canvas/blocks/universal/UniversalBlock.tsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blockSystem/renderRegistry.tsx | Canvas system module |
| src/canvas/brick.ts | USED (prod graph) | src/canvas/Canvas.tsx | Canvas system module |
| src/canvas/commands.ts | UNUSED CANDIDATE (only in orphan graph) | src/canvas/SlashCommandMenu.tsx | Canvas system module |
| src/canvas/types.ts | USED (prod graph) | src/canvas/Canvas.tsx, src/canvas/blocks/CodeBlock.tsx, src/canvas/brick.ts | Canvas system module |
| src/canvas/utils/isInViewport.ts | USED (prod graph) | src/canvas/Canvas.tsx | Canvas system module |
| src/canvas/utils/migrateBlocks.ts | USED (prod graph) | src/store/canvasStore.ts | Canvas system module |
| src/canvas/utils/snap.ts | USED (prod graph) | src/canvas/Canvas.tsx, src/canvas/blocks/CreateBlock.tsx, src/canvas/blocks/DesignBlock.tsx | Canvas system module |
| src/canvas/utils/youtube.ts | USED (prod graph) | src/canvas/Canvas.tsx, src/canvas/blocks/YouTubeBlock.tsx, src/pages/OmniaCanvas.tsx | Canvas system module |
| src/components/AppSidebar.jsx | USED (prod graph) | src/App.jsx | App component |
| src/components/LoadingScreen.tsx | USED (prod graph) | src/App.jsx | App component |
| src/components/ProjectGrid.tsx | USED (prod graph) | src/pages/Dashboard.tsx | App component |
| src/components/ProjectModal.tsx | USED (prod graph) | src/pages/Dashboard.tsx | App component |
| src/components/UserNotRegisteredError.jsx | UNUSED CANDIDATE (no refs) |  | App component |
| src/components/files/DragDropFileUpload.jsx | USED (prod graph) | src/pages/Memory.jsx, src/pages/new/MemoryNew.jsx | File feature component |
| src/components/notes/AIAnalysisPanel.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/AIContentPanel.jsx | UNUSED CANDIDATE (no refs) |  | Legacy notes feature component |
| src/components/notes/AISearchOverlay.jsx | UNUSED CANDIDATE (only in orphan graph) | src/pages/Create.jsx | Legacy notes feature component |
| src/components/notes/AISearchPopup.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/AttachmentPanel.jsx | USED (prod graph) | src/components/notes/NoteCreator.jsx, src/components/notes/NoteViewer.jsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/AutoArchive.jsx | UNUSED CANDIDATE (no refs) |  | Legacy notes feature component |
| src/components/notes/BrickEditor.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/ChatPanel.jsx | UNUSED CANDIDATE (no refs) |  | Legacy notes feature component |
| src/components/notes/ColorMenu.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/ConnectionSuggestions.jsx | USED (prod graph) | src/components/notes/NoteCreator.jsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/DesignBoardBlock.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/BrickEditor.jsx | Legacy notes feature component |
| src/components/notes/DraggableChat.jsx | USED (prod graph) | src/pages/Create.jsx, src/pages/Dashboard.tsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/DraggableQuickNote.tsx | USED (prod graph) | src/pages/Dashboard.tsx, src/pages/new/MemoryNew.jsx | Legacy notes feature component |
| src/components/notes/DuplicateDetector.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/EnhancedKnowledgeGraph.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/FollowUpQuestions.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/KnowledgeGraph.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/MarginButton.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/MindMapGenerator.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/NoteCreator.jsx | UNUSED CANDIDATE (only in orphan graph) | src/pages/Create.jsx | Legacy notes feature component |
| src/components/notes/NoteLinkSelector.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/NoteSidebar.jsx | UNUSED CANDIDATE (no refs) |  | Legacy notes feature component |
| src/components/notes/NoteSummarization.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/NoteViewer.jsx | USED (prod graph) | src/pages/Create.jsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/NotionSidebar.jsx | USED (prod graph) | src/components/notes/ResponsiveSidebar.jsx, src/pages/Create.jsx | Legacy notes feature component |
| src/components/notes/RecommendationsPanel.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/ReminderNotifications.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/ReminderPicker.jsx | USED (prod graph) | src/components/notes/NoteCreator.jsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/ResponsiveSidebar.jsx | USED (prod graph) | src/pages/Billing.jsx, src/pages/Memory.jsx, src/pages/MemoryChat.jsx | Legacy notes feature component |
| src/components/notes/RichTextRenderer.jsx | USED (prod graph) | src/components/notes/NoteViewer.jsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/SearchModal.jsx | UNUSED CANDIDATE (no refs) |  | Legacy notes feature component |
| src/components/notes/SettingsModal.jsx | USED (prod graph) | src/pages/Billing.jsx, src/pages/Create.jsx, src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/SlashCommandMenu.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/BrickEditor.jsx, src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/SpreadsheetBlock.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/BrickEditor.jsx | Legacy notes feature component |
| src/components/notes/TagInput.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/TextHighlighter.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/TrashCleanup.jsx | USED (prod graph) | src/pages/Memory.jsx | Legacy notes feature component |
| src/components/notes/YouTubeEmbed.jsx | USED (prod graph) | src/components/notes/AttachmentPanel.jsx, src/components/notes/BrickEditor.jsx, src/components/notes/NoteCreator.jsx | Legacy notes feature component |
| src/components/notes/YouTubeSearch.jsx | UNUSED CANDIDATE (no refs) |  | Legacy notes feature component |
| src/components/notes/blockModel.js | USED (prod graph) | src/components/notes/BrickEditor.jsx, src/components/notes/NoteCreator.jsx, src/pages/Create.jsx | Legacy notes feature component |
| src/components/ui/accordion.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/alert-dialog.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/alert.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/aspect-ratio.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/avatar.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/badge.jsx | USED (prod graph) | src/components/notes/EnhancedKnowledgeGraph.jsx, src/components/notes/NoteViewer.jsx, src/pages/Trash.jsx | Shared UI primitive |
| src/components/ui/breadcrumb.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/button.jsx | USED (prod graph) | src/components/files/DragDropFileUpload.jsx, src/components/notes/AIAnalysisPanel.jsx, src/components/notes/AIContentPanel.jsx | Shared UI primitive |
| src/components/ui/calendar.jsx | USED (prod graph) | src/components/notes/ReminderPicker.jsx | Shared UI primitive |
| src/components/ui/card.jsx | USED (prod graph) | src/components/notes/DuplicateDetector.jsx, src/components/notes/EnhancedKnowledgeGraph.jsx, src/components/notes/RecommendationsPanel.jsx | Shared UI primitive |
| src/components/ui/carousel.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/chart.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/checkbox.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/collapsible.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/command.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/context-menu.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/dialog.jsx | USED (prod graph) | src/components/ProjectModal.tsx, src/components/notes/AISearchOverlay.jsx, src/components/notes/AttachmentPanel.jsx | Shared UI primitive |
| src/components/ui/drawer.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/dropdown-menu.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/form.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/hover-card.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/input-otp.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/input.jsx | USED (prod graph) | src/components/notes/AISearchOverlay.jsx, src/components/notes/AttachmentPanel.jsx, src/components/notes/DraggableChat.jsx | Shared UI primitive |
| src/components/ui/label.jsx | USED (prod graph) | src/components/notes/DuplicateDetector.jsx, src/components/notes/ReminderPicker.jsx, src/components/notes/SettingsModal.jsx | Shared UI primitive |
| src/components/ui/menubar.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/navigation-menu.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/pagination.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/popover.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/progress.jsx | USED (prod graph) | src/components/files/DragDropFileUpload.jsx | Shared UI primitive |
| src/components/ui/radio-group.jsx | USED (prod graph) | src/components/notes/DuplicateDetector.jsx | Shared UI primitive |
| src/components/ui/resizable.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/scroll-area.jsx | USED (prod graph) | src/components/notes/AIContentPanel.jsx, src/components/notes/AISearchOverlay.jsx, src/components/notes/AISearchPopup.jsx | Shared UI primitive |
| src/components/ui/select.jsx | USED (prod graph) | src/components/notes/AttachmentPanel.jsx, src/components/notes/BrickEditor.jsx, src/components/notes/EnhancedKnowledgeGraph.jsx | Shared UI primitive |
| src/components/ui/separator.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/ui/sidebar.jsx | Shared UI primitive |
| src/components/ui/sheet.jsx | USED (prod graph) | src/components/notes/ResponsiveSidebar.jsx, src/components/ui/sidebar.jsx | Shared UI primitive |
| src/components/ui/sidebar.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/skeleton.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/ui/sidebar.jsx | Shared UI primitive |
| src/components/ui/slider.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/sonner.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/switch.jsx | USED (prod graph) | src/components/notes/SettingsModal.jsx | Shared UI primitive |
| src/components/ui/table.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/tabs.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/textarea.jsx | USED (prod graph) | src/components/notes/NoteCreator.jsx, src/pages/Memory.jsx | Shared UI primitive |
| src/components/ui/toast.jsx | USED (prod graph) | src/components/ui/toaster.jsx | Shared UI primitive |
| src/components/ui/toaster.jsx | USED (prod graph) | src/App.jsx | Shared UI primitive |
| src/components/ui/toggle-group.jsx | UNUSED CANDIDATE (no refs) |  | Shared UI primitive |
| src/components/ui/toggle.jsx | UNUSED CANDIDATE (only in orphan graph) | src/components/ui/toggle-group.jsx | Shared UI primitive |
| src/components/ui/tooltip.jsx | USED (prod graph) | src/components/notes/NotionSidebar.jsx, src/components/ui/sidebar.jsx | Shared UI primitive |
| src/components/ui/use-toast.jsx | USED (prod graph) | src/components/ui/toaster.jsx | Shared UI primitive |
| src/globals.css | UNUSED CANDIDATE (no refs) |  | Frontend source file |
| src/hooks/use-mobile.jsx | USED (prod graph) | src/components/notes/ResponsiveSidebar.jsx, src/components/ui/sidebar.jsx | Custom React hook |
| src/index.css | USED (prod graph) | src/main.jsx | Frontend source file |
| src/lib/AuthContext.jsx | UNUSED CANDIDATE (no refs) |  | Frontend support library |
| src/lib/ErrorBoundary.jsx | USED (prod graph) | src/main.jsx | Frontend support library |
| src/lib/NavigationTracker.jsx | UNUSED CANDIDATE (no refs) |  | Frontend support library |
| src/lib/PageNotFound.jsx | USED (prod graph) | src/App.jsx | Frontend support library |
| src/lib/SupabaseAuth.jsx | USED (prod graph) | src/App.jsx, src/components/AppSidebar.jsx, src/components/files/DragDropFileUpload.jsx | Frontend support library |
| src/lib/VisualEditAgent.jsx | UNUSED CANDIDATE (no refs) |  | Frontend support library |
| src/lib/ai-model.js | USED (prod graph) | src/components/notes/AIAnalysisPanel.jsx, src/components/notes/AISearchOverlay.jsx, src/components/notes/ConnectionSuggestions.jsx | Frontend support library |
| src/lib/api-config.js | USED (prod graph) | src/canvas/Canvas.tsx, src/components/notes/AIAnalysisPanel.jsx, src/components/notes/AISearchOverlay.jsx | Frontend support library |
| src/lib/app-params.js | UNUSED CANDIDATE (only in orphan graph) | src/lib/AuthContext.jsx | Frontend support library |
| src/lib/projectKnowledgeBase.ts | USED (prod graph) | src/pages/OmniaCanvas.tsx, src/store/aiStore.ts | Frontend support library |
| src/lib/query-client.js | USED (prod graph) | src/App.jsx | Frontend support library |
| src/lib/supabase.ts | USED (prod graph) | src/components/AppSidebar.jsx, src/components/files/DragDropFileUpload.jsx, src/components/notes/NoteCreator.jsx | Frontend support library |
| src/lib/utils.js | USED (prod graph) | src/components/notes/BrickEditor.jsx, src/components/ui/accordion.jsx, src/components/ui/alert-dialog.jsx | Frontend support library |
| src/lib/youtubeUtils.js | USED (prod graph) | src/components/notes/BrickEditor.jsx, src/components/notes/NoteCreator.jsx, src/components/notes/YouTubeEmbed.jsx | Frontend support library |
| src/main.jsx | USED (prod graph) |  | Frontend app entrypoint |
| src/omnia/DesignBoardBlock.jsx | UNUSED CANDIDATE (only in orphan graph) | src/canvas/blocks/DesignBlock.tsx | Legacy Omnia module |
| src/omnia/DraggableChat.jsx | UNUSED CANDIDATE (no refs) |  | Legacy Omnia module |
| src/omnia/blockModel.js | UNUSED CANDIDATE (no refs) |  | Legacy Omnia module |
| src/pages.config.js | UNUSED CANDIDATE (only in orphan graph) | src/lib/NavigationTracker.jsx | Frontend source file |
| src/pages/AISearch.jsx | UNUSED CANDIDATE (no refs) |  | Route/page component |
| src/pages/Billing.jsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/Chat.jsx | USED (prod graph) | src/App.jsx | Route/page component |
| src/pages/Create.jsx | UNUSED CANDIDATE (no refs) |  | Route/page component |
| src/pages/Dashboard.tsx | USED (prod graph) | src/App.jsx | Route/page component |
| src/pages/Home.jsx | UNUSED CANDIDATE (no refs) |  | Route/page component |
| src/pages/Login.jsx | USED (prod graph) | src/App.jsx | Route/page component |
| src/pages/LongTerm.jsx | UNUSED CANDIDATE (no refs) |  | Route/page component |
| src/pages/Memory.jsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/MemoryChat.jsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/Notes.jsx | UNUSED CANDIDATE (no refs) |  | Route/page component |
| src/pages/OmniaCanvas.tsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/ProjectPlaceholder.tsx | USED (prod graph) | src/App.jsx | Route/page component |
| src/pages/Reminders.jsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/Settings.tsx | USED (prod graph) | src/App.jsx | Route/page component |
| src/pages/TagManagement.jsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/Trash.jsx | USED (prod graph) | src/App.jsx, src/pages.config.js | Route/page component |
| src/pages/api/ai/invoke.ts | UNUSED CANDIDATE (no refs) |  | Route/page component |
| src/pages/new/BillingNew.jsx | USED (prod graph) | src/App.jsx | New route/page component |
| src/pages/new/MemoryChatNew.jsx | USED (prod graph) | src/App.jsx | New route/page component |
| src/pages/new/MemoryNew.jsx | USED (prod graph) | src/App.jsx | New route/page component |
| src/pages/new/RemindersNew.jsx | USED (prod graph) | src/App.jsx | New route/page component |
| src/pages/new/TagManagementNew.jsx | USED (prod graph) | src/App.jsx | New route/page component |
| src/pages/new/TrashNew.jsx | USED (prod graph) | src/App.jsx | New route/page component |
| src/store/aiStore.ts | USED (prod graph) | src/pages/OmniaCanvas.tsx | State store module |
| src/store/canvasStore.ts | USED (prod graph) | src/canvas/Canvas.tsx, src/canvas/blocks/CodeBlock.tsx, src/canvas/blocks/CreateBlock.tsx | State store module |
| src/store/mindmapStore.ts | USED (prod graph) | src/pages/ProjectPlaceholder.tsx | State store module |
| src/ui-select-shim.d.ts | UNUSED CANDIDATE (no refs) |  | Frontend source file |
| src/utils/index.ts | USED (prod graph) | src/components/notes/FollowUpQuestions.jsx, src/components/notes/KnowledgeGraph.jsx, src/components/notes/NoteCreator.jsx | Shared utility module |
| src/vite-env.d.ts | UNUSED CANDIDATE (no refs) |  | Frontend source file |
| supabase-migrations/001_file_storage_system.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/002_omnia_boards.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/003_omnia_projects.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/004_omnia_boards_project.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/005_omnia_boards_default_title.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/006_omnia_project_mindmaps.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/007_omnia_mindmap_links.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/008_memory_cleanup_oversized_note_content.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| supabase-migrations/009_notes_user_updated_at_index.sql | USED MANUALLY (DB migration) |  | SQL migration file (manual DB apply) |
| tailwind.config.js | USED (tooling/runtime) |  | Tailwind configuration |
| vercel.json | USED (tooling/runtime) |  | Vercel deployment config |
| vite.config.js | USED (tooling/runtime) |  | Vite configuration |
| youtubeQa.js | USED (server dependency) | server.js, youtubeQa.test.js | YouTube QA helper used by server/tests |
| youtubeQa.test.js | USED (test entrypoint) |  | Node test entrypoint |
