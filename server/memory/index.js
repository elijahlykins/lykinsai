// ============================================================================
// server/memory — Markdown memory core (Memory Architecture Replacement, Phase 1)
// ============================================================================
// Single import point for the Phase 2 integration. See docs/memory-architecture.md.

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
