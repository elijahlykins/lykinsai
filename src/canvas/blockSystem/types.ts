export type UniversalBlockType = string;
export type BrickTrait = "text" | "checkbox" | "button" | "input" | "dropdown" | "container";

export type BrickConnection = {
  id: string;
  fromId: string;
  toId: string;
  distance: number;
  kind: "neighbor";
};

export type UniversalPermissionRole = "view" | "edit" | "admin";
export type UniversalVisibility = "visible" | "hidden" | "conditional";
export type UniversalDataSourceKind = "none" | "internal" | "external";
export type UniversalConnectionType = "data" | "event" | "containment" | "semantic";
export type DatabasePropertyType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multi_select"
  | "status"
  | "checkbox"
  | "file"
  | "relation"
  | "formula";
export type DatabaseViewType = "table" | "board" | "calendar" | "timeline" | "gallery" | "list";
export type RelationType = "one-to-one" | "one-to-many" | "many-to-many";

export type UniversalInputPort = {
  id: string;
  name: string;
  dataType?: string;
  required?: boolean;
};

export type UniversalOutputPort = {
  id: string;
  name: string;
  dataType?: string;
};

export type UniversalEventMap = {
  emits: string[];
  listensTo: string[];
};

export type UniversalLogic = {
  conditions: string[];
  filters: string[];
  dependencies: string[];
  triggers: string[];
};

export type UniversalAiContext = {
  purpose: string;
  tags: string[];
  semanticType: string;
};

export type UniversalBlockConnection = {
  id: string;
  type: UniversalConnectionType;
  fromBlockId: string;
  toBlockId: string;
  fromPort?: string;
  toPort?: string;
  eventName?: string;
  relationship?: string;
  metadata?: Record<string, unknown>;
};

export type UniversalBlockRuntime = {
  blockType: UniversalBlockType;
  dataSource: {
    kind: UniversalDataSourceKind;
    inputs: UniversalInputPort[];
    outputs: UniversalOutputPort[];
  };
  permissions: UniversalPermissionRole[];
  visibility: UniversalVisibility;
  events: UniversalEventMap;
  logic: UniversalLogic;
  aiContext: UniversalAiContext;
  connections: UniversalBlockConnection[];
  // Notion-style additive schema layers
  blockDefinition?: BlockInstanceDefinition;
  behavior?: BlockBehaviorLayer;
  dataModel?: BlockDataLayer;
};

export type BrickData = {
  trait: BrickTrait;
  content?: string;
  state?: Record<string, unknown>;
  children?: string[];
  connections?: BrickConnection[];
  metadata?: Record<string, unknown>;
};

export type BlockDefinition = {
  type: UniversalBlockType;
  name: string;
  category: "data" | "content" | "input" | "logic" | "visualization" | "ai" | "system" | "container";
  isContainer: boolean;
  allowedChildren?: UniversalBlockType[];
  defaultSize: { w: number; h: number };
  dataSourceDefault: UniversalDataSourceKind;
  defaultInputs?: UniversalInputPort[];
  defaultOutputs?: UniversalOutputPort[];
  defaultEvents?: UniversalEventMap;
  defaultLogic?: Partial<UniversalLogic>;
  defaultAiContext?: Partial<UniversalAiContext>;
  renderVariant: "text" | "list" | "sheet" | "spreadsheet" | "code" | "taskboard" | "design" | "ui";
};

export type BlockBehaviorLayer = {
  isContainer: boolean;
  isDatabase: boolean;
  supportsChildren: boolean;
};

export type BlockDataLayer = {
  properties: Record<string, unknown>;
  dataSource: UniversalDataSourceKind;
};

export type BlockInstanceDefinition = {
  id: string;
  type: UniversalBlockType;
  name: string;
  parentId: string | null;
  childrenIds: string[];
  position: { x: number; y: number };
  size: { w: number; h: number };
  behavior: BlockBehaviorLayer;
  data: BlockDataLayer;
  permissions: UniversalPermissionRole[];
  visibility: UniversalVisibility;
};

export type RelationProperty = {
  targetDatabaseId: string;
  relationType: RelationType;
};

export type RollupDefinition = {
  sourceRelation: string;
  property: string;
  aggregation: "sum" | "count" | "average" | "min" | "max";
};

export type DatabasePropertyDefinition = {
  id: string;
  name: string;
  type: DatabasePropertyType;
  options?: string[];
  relation?: RelationProperty;
  formula?: string;
  rollup?: RollupDefinition;
};

export type DatabaseEntry = {
  id: string;
  blockId?: string;
  pageLike?: boolean;
  properties: Record<string, unknown>;
};

export type ViewDefinition = {
  id: string;
  viewType: DatabaseViewType;
  filters: string[];
  sorting: string[];
  grouping: string[];
  visibleProperties: string[];
};

export type DatabaseBlockData = {
  id: string;
  propertiesSchema: DatabasePropertyDefinition[];
  entries: DatabaseEntry[];
  views: ViewDefinition[];
  relations: RelationProperty[];
  rollups: RollupDefinition[];
};

export const UNIVERSAL_CONTAINER_BLOCKS: UniversalBlockType[] = [];

export const DEFAULT_UNIVERSAL_EVENTS: UniversalEventMap = { emits: [], listensTo: [] };
export const DEFAULT_UNIVERSAL_LOGIC: UniversalLogic = { conditions: [], filters: [], dependencies: [], triggers: [] };
export const DEFAULT_UNIVERSAL_AI_CONTEXT: UniversalAiContext = { purpose: "", tags: [], semanticType: "" };

