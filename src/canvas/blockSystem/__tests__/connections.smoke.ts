import { normalizeConnection, validateConnection } from "@/canvas/blockSystem/connections";

export function runConnectionsSmokeTest() {
  const c = normalizeConnection({
    type: "data",
    fromBlockId: "a",
    toBlockId: "b",
  });
  const ok = validateConnection(c);
  if (!ok.ok) throw new Error(`Connection should be valid: ${ok.errors.join(", ")}`);

  const bad = validateConnection({
    ...c,
    id: "",
    fromBlockId: "a",
    toBlockId: "a",
  });
  if (bad.ok) throw new Error("Invalid connection unexpectedly passed validation.");
  return true;
}

