// ============================================================================
// server/memory — production Markdown personal-memory system
// ============================================================================
// Single import point. See docs/memory-architecture.md.

export * from './memoryConfig.js';
export * from './memoryPaths.js';
export * from './memoryPolicy.js';
export * from './memoryMarkdown.js';
export { createSupabaseMemoryStore } from './memoryStore.js';
export { listMemoryRegistry, formatMemoryRegistry } from './memoryRegistry.js';
export { readMemoryDocument } from './memoryReader.js';
export { createMemoryDocument, patchMemoryDocument, forgetMemory } from './memoryWriter.js';
export { resolveMemoryContext, buildMemoryL0Block, measureMemoryFootprint } from './memoryResolver.js';
export { memoryNeedsCompaction, compactMemoryMarkdown, compactMemoryDocument } from './memoryMaintenance.js';
export {
  memoryList,
  memoryRead,
  memoryPatch,
  memoryCreate,
  memoryForget,
  MEMORY_TOOL_DEFINITIONS,
} from './memoryTools.js';
export {
  migrateUserMemory,
  ensureLegacyMemoryMigrated,
  isTrustworthyLegacyFact,
  groupTrustworthyFactsByPath,
  resetMemoryMigrationCache,
} from './memoryMigration.js';
export {
  getMemoryStore,
  resolveChatMemoryTurn,
  formatChatMemoryPrompt,
  invalidateMemoryThreadPath,
  resetMemoryThreadCache,
} from './memoryChat.js';
