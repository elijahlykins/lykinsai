import type {
  BlockBehaviorLayer,
  BlockDataLayer,
  BlockInstanceDefinition,
  DatabaseBlockData,
  DatabaseEntry,
  DatabasePropertyDefinition,
  DatabaseViewType,
  RelationProperty,
  RollupDefinition,
  UniversalBlockType,
} from "@/lyknChat/blockSystem/types";
import { getBlockDefinition } from "@/lyknChat/blockSystem/definitions";

const makeId = (prefix = "id") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createBlockBehavior(type: UniversalBlockType): BlockBehaviorLayer {
  const def = getBlockDefinition(type);
  const isContainer = Boolean(def?.isContainer || type === "page");
  return {
    isContainer,
    isDatabase: type === "database",
    supportsChildren: isContainer || type === "database",
  };
}

export function createBlockDataLayer(type: UniversalBlockType): BlockDataLayer {
  return {
    properties: {},
    dataSource: type === "database" ? "internal" : "none",
  };
}

export function createBlockInstanceDefinition(args: {
  id: string;
  type: UniversalBlockType;
  name: string;
  parentId?: string | null;
  position: { x: number; y: number };
  size: { w: number; h: number };
}): BlockInstanceDefinition {
  const { id, type, name, parentId = null, position, size } = args;
  return {
    id,
    type,
    name,
    parentId,
    childrenIds: [],
    position,
    size,
    behavior: createBlockBehavior(type),
    data: createBlockDataLayer(type),
    permissions: ["view", "edit", "admin"],
    visibility: "visible",
  };
}

export function defaultDatabasePropertySchema(): DatabasePropertyDefinition[] {
  return [
    { id: makeId("prop"), name: "Name", type: "text" },
    { id: makeId("prop"), name: "Status", type: "status", options: ["Not Started", "In Progress", "Done"] },
    { id: makeId("prop"), name: "Notes", type: "text" },
  ];
}

export function defaultDatabaseEntries(): DatabaseEntry[] {
  return [
    { id: makeId("entry"), pageLike: true, properties: { Name: "Item 1", Status: "Not Started", Priority: "Medium" } },
    { id: makeId("entry"), pageLike: true, properties: { Name: "Item 2", Status: "In Progress", Priority: "High" } },
  ];
}

export function defaultDatabaseViews() {
  const makeView = (viewType: DatabaseViewType, name: string) => ({
    id: makeId("view"),
    viewType,
    filters: [],
    sorting: [],
    grouping: [],
    visibleProperties: ["Name", "Status", "Notes"],
    name,
  });
  return [
    makeView("table", "Table"),
    makeView("list", "List"),
  ];
}

export function createDatabaseBlockData(overrides?: Partial<DatabaseBlockData>): DatabaseBlockData {
  const propertiesSchema = overrides?.propertiesSchema || defaultDatabasePropertySchema();
  const entries = overrides?.entries || defaultDatabaseEntries();
  const views = overrides?.views || defaultDatabaseViews();
  const relations: RelationProperty[] = overrides?.relations || [];
  const rollups: RollupDefinition[] = overrides?.rollups || [];
  return {
    id: overrides?.id || makeId("db"),
    propertiesSchema,
    entries,
    views: views as any,
    relations,
    rollups,
  };
}

export function appendChildId(parentData: any, childId: string) {
  const list = Array.isArray(parentData?.childrenIds) ? parentData.childrenIds : [];
  if (!list.includes(childId)) list.push(childId);
  return list;
}

