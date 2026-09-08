/**
 * Read engineering / CAD / mesh files into a short text brief the model can
 * use. The original bytes stay on disk or in storage; this is the "what is
 * this part" pass so a drag-in STEP or STL is not a silent binary.
 *
 * Parsers stay dependency-free so the same module runs in the chat renderer
 * and in Electron local_read_file.
 */

export const ENGINEERING_EXTENSIONS = Object.freeze([
  // meshes
  "stl", "obj", "ply", "glb", "gltf", "3mf", "fbx", "dae", "3ds", "usdz",
  // B-rep / CAD exchange
  "step", "stp", "iges", "igs", "brep", "sat", "x_t", "x_b",
  // drawings
  "dxf", "dwg",
  // native / parametric
  "scad", "fcstd", "3dm", "sldprt", "sldasm", "ipt", "iam", "prt",
  "catpart", "catproduct", "f3d",
  // CAM
  "gcode", "nc", "tap",
]);

export const ENGINEERING_EXT_SET = new Set(ENGINEERING_EXTENSIONS);

const FAMILY = {
  stl: "triangle mesh",
  obj: "triangle/quad mesh",
  ply: "polygon mesh",
  glb: "glTF binary scene",
  gltf: "glTF scene",
  "3mf": "3D manufacturing format",
  fbx: "Autodesk FBX scene",
  dae: "COLLADA scene",
  step: "STEP CAD (B-rep)",
  stp: "STEP CAD (B-rep)",
  iges: "IGES CAD",
  igs: "IGES CAD",
  dxf: "DXF drawing",
  dwg: "DWG drawing",
  scad: "OpenSCAD script",
  fcstd: "FreeCAD document",
  "3dm": "Rhino 3DM",
  sldprt: "SolidWorks part",
  sldasm: "SolidWorks assembly",
  ipt: "Inventor part",
  iam: "Inventor assembly",
  prt: "CAD part",
  gcode: "CNC toolpath",
  nc: "CNC toolpath",
};

const MAX_PARSE_BYTES = 8 * 1024 * 1024;
const MAX_BRIEF_CHARS = 6000;

export function engineeringExt(name = "") {
  const leaf = String(name || "").split(/[\\/]/).pop() || "";
  const dot = leaf.lastIndexOf(".");
  return dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

export function isEngineeringPath(name = "") {
  return ENGINEERING_EXT_SET.has(engineeringExt(name));
}

export function engineeringFileAccept() {
  return ENGINEERING_EXTENSIONS.map((e) => `.${e}`).join(",");
}

function familyOf(ext) {
  return FAMILY[ext] || "engineering file";
}

function fmtMm(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1000) return `${(n / 1000).toFixed(3)} m`;
  if (abs >= 1) return `${n.toFixed(2)} mm`;
  return `${(n * 1000).toFixed(2)} µm`;
}

function bboxLine(min, max, unitHint) {
  if (!min || !max) return "";
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  if (![dx, dy, dz].every(Number.isFinite)) return "";
  const span = unitHint === "m"
    ? `${dx.toFixed(3)} × ${dy.toFixed(3)} × ${dz.toFixed(3)} m`
    : [fmtMm(dx), fmtMm(dy), fmtMm(dz)].filter(Boolean).join(" × ");
  return `Bounding box: ${span}`;
}

function decodeText(bytes, max = MAX_PARSE_BYTES) {
  const slice = bytes.byteLength > max ? bytes.subarray(0, max) : bytes;
  let nul = slice.length;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      nul = i;
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(slice.subarray(0, nul));
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function growBBox(bbox, x, y, z) {
  if (!bbox.min) {
    bbox.min = [x, y, z];
    bbox.max = [x, y, z];
    return;
  }
  bbox.min[0] = Math.min(bbox.min[0], x);
  bbox.min[1] = Math.min(bbox.min[1], y);
  bbox.min[2] = Math.min(bbox.min[2], z);
  bbox.max[0] = Math.max(bbox.max[0], x);
  bbox.max[1] = Math.max(bbox.max[1], y);
  bbox.max[2] = Math.max(bbox.max[2], z);
}

function parseAsciiStl(text) {
  let faces = 0;
  const bbox = {};
  const vertRe = /vertex\s+([-+eE0-9.]+)\s+([-+eE0-9.]+)\s+([-+eE0-9.]+)/g;
  let m;
  while ((m = vertRe.exec(text))) {
    growBBox(bbox, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const faceRe = /facet\s+normal/gi;
  while (faceRe.exec(text)) faces += 1;
  return { faces, bbox };
}

function parseBinaryStl(bytes) {
  if (bytes.byteLength < 84) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(80, true);
  if (faces <= 0 || faces > 20_000_000) return null;
  const expected = 84 + faces * 50;
  const bbox = {};
  const usable = Math.min(faces, Math.floor((bytes.byteLength - 84) / 50));
  for (let i = 0; i < usable; i++) {
    const off = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const b = off + v * 12;
      growBBox(bbox, view.getFloat32(b, true), view.getFloat32(b + 4, true), view.getFloat32(b + 8, true));
    }
  }
  return { faces, bbox, truncated: usable < faces, expected };
}

function summarizeStl(bytes) {
  const head = decodeText(bytes.subarray(0, 80), 80).trim().toLowerCase();
  const ascii = head.startsWith("solid") && !looksBinary(bytes.subarray(0, 256));
  const parsed = ascii ? parseAsciiStl(decodeText(bytes)) : parseBinaryStl(bytes);
  if (!parsed) return "STL mesh (could not parse header).";
  const lines = [
    `STL ${ascii ? "ASCII" : "binary"} mesh`,
    `${parsed.faces.toLocaleString()} triangles`,
  ];
  const box = bboxLine(parsed.bbox?.min, parsed.bbox?.max);
  if (box) lines.push(`${box} (units as stored in the file — often mm)`);
  if (parsed.truncated) lines.push("File was truncated for this read; triangle count is from the header.");
  return lines.join("\n");
}

function summarizeObj(text) {
  let verts = 0;
  let faces = 0;
  const objects = [];
  const bbox = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      verts += 1;
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      if (p.length >= 3) growBBox(bbox, p[0], p[1], p[2]);
    } else if (line.startsWith("f ")) faces += 1;
    else if (line.startsWith("o ") || line.startsWith("g ")) {
      const name = line.slice(2).trim();
      if (name && objects.length < 24 && !objects.includes(name)) objects.push(name);
    }
  }
  const lines = [`OBJ mesh`, `${verts.toLocaleString()} vertices, ${faces.toLocaleString()} faces`];
  const box = bboxLine(bbox.min, bbox.max);
  if (box) lines.push(box);
  if (objects.length) lines.push(`Named groups: ${objects.join(", ")}`);
  return lines.join("\n");
}

function summarizePly(text) {
  const headerEnd = text.indexOf("end_header");
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text.slice(0, 2000);
  const verts = /element\s+vertex\s+(\d+)/i.exec(header);
  const faces = /element\s+face\s+(\d+)/i.exec(header);
  const lines = ["PLY mesh"];
  if (verts) lines.push(`${Number(verts[1]).toLocaleString()} vertices`);
  if (faces) lines.push(`${Number(faces[1]).toLocaleString()} faces`);
  return lines.join("\n");
}

function uniqueNames(list, cap = 20) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

function summarizeGltfJson(json) {
  const meshes = Array.isArray(json?.meshes) ? json.meshes : [];
  const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
  const names = uniqueNames([
    ...meshes.map((m) => m?.name),
    ...nodes.map((n) => n?.name),
  ]);
  const lines = [
    "glTF scene",
    `${meshes.length} mesh${meshes.length === 1 ? "" : "es"}, ${nodes.length} node${nodes.length === 1 ? "" : "s"}`,
  ];
  if (names.length) lines.push(`Parts: ${names.join(", ")}`);
  return lines.join("\n");
}

function summarizeGlb(bytes) {
  if (bytes.byteLength < 20) return "GLB scene (too small to parse).";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return "GLB scene (missing glTF magic).";
  const jsonLen = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4e4f534a) return "GLB scene (unexpected chunk).";
  const start = 20;
  const end = Math.min(bytes.byteLength, start + jsonLen);
  try {
    const json = JSON.parse(decodeText(bytes.subarray(start, end), end - start));
    return summarizeGltfJson(json);
  } catch {
    return "GLB scene (JSON chunk could not be parsed).";
  }
}

function summarizeStep(text) {
  const fileName = /FILE_NAME\s*\(\s*'([^']+)'/i.exec(text);
  const desc = /FILE_DESCRIPTION\s*\(\s*\(\s*'([^']+)'/i.exec(text);
  const products = uniqueNames(
    [...text.matchAll(/\bPRODUCT\s*\(\s*'([^']+)'/gi)].map((m) => m[1]),
    24,
  );
  const points = (text.match(/\bCARTESIAN_POINT\b/g) || []).length;
  const lines = ["STEP CAD model (B-rep, not a triangle mesh)"];
  if (fileName) lines.push(`Source name: ${fileName[1]}`);
  if (desc) lines.push(`Description: ${desc[1]}`);
  if (products.length) lines.push(`Products/parts: ${products.join(", ")}`);
  if (points) lines.push(`${points.toLocaleString()} Cartesian points in this excerpt`);
  lines.push("Use a CAD kernel (build123d / OpenCASCADE) when you need exact dimensions or a mesh export.");
  return lines.join("\n");
}

function summarizeIges(text) {
  const start = text.split(/\r?\n/).slice(0, 8).map((l) => l.replace(/\s+\d+\s*$/, "").trim()).filter(Boolean);
  const lines = ["IGES CAD model"];
  if (start.length) lines.push(start.slice(0, 4).join(" | "));
  return lines.join("\n");
}

function summarizeDxf(text) {
  const layers = uniqueNames(
    [...text.matchAll(/\nLAYER\n[\s\S]{0,80}?\n(?:2\n([^\n]+))/gi)].map((m) => m[1]),
    16,
  );
  const texts = uniqueNames(
    [...text.matchAll(/\nTEXT\n[\s\S]{0,200}?\n1\n([^\n]+)/gi)].map((m) => m[1]),
    12,
  );
  const lines = ["DXF drawing"];
  if (layers.length) lines.push(`Layers: ${layers.join(", ")}`);
  if (texts.length) lines.push(`Text: ${texts.join("; ")}`);
  const ents = (text.match(/\n(?:LINE|CIRCLE|ARC|LWPOLYLINE|INSERT|TEXT|DIMENSION)\n/g) || []).length;
  if (ents) lines.push(`${ents.toLocaleString()} drawing entities in this excerpt`);
  return lines.join("\n");
}

function summarizeGcode(text) {
  const comments = uniqueNames(
    [...text.matchAll(/[;(]([^)\n]{2,80})/g)].map((m) => m[1].trim()),
    8,
  );
  const bbox = {};
  const word = /\b([XYZ])\s*([-+0-9.]+)/g;
  let m;
  let x;
  let y;
  let z;
  const sample = text.slice(0, 400_000);
  while ((m = word.exec(sample))) {
    const axis = m[1];
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    if (axis === "X") x = n;
    if (axis === "Y") y = n;
    if (axis === "Z") z = n;
    if (x != null && y != null && z != null) growBBox(bbox, x, y, z);
    else if (x != null && y != null) growBBox(bbox, x, y, z || 0);
  }
  const lines = ["CNC toolpath (G-code)"];
  if (comments.length) lines.push(`Header: ${comments.join(" | ")}`);
  const box = bboxLine(bbox.min, bbox.max);
  if (box) lines.push(box);
  return lines.join("\n");
}

function summarizeScad(text) {
  const modules = uniqueNames(
    [...text.matchAll(/\bmodule\s+([A-Za-z_][\w]*)/g)].map((m) => m[1]),
    16,
  );
  const lines = ["OpenSCAD script"];
  if (modules.length) lines.push(`Modules: ${modules.join(", ")}`);
  const excerpt = text.slice(0, 1200).trim();
  if (excerpt) lines.push(`Excerpt:\n${excerpt}`);
  return lines.join("\n");
}

function genericBrief(name, ext, bytes) {
  const lines = [
    `${familyOf(ext)} (.${ext})`,
    `${bytes.byteLength.toLocaleString()} bytes`,
  ];
  if (looksBinary(bytes.subarray(0, 8192))) {
    lines.push(
      "Binary CAD/native format — LYKN can keep the file and import it in Build, but this format has no text layer to quote here.",
    );
  } else {
    const excerpt = decodeText(bytes, 1500).trim();
    if (excerpt) lines.push(`Excerpt:\n${excerpt.slice(0, 1200)}`);
  }
  return lines.join("\n");
}

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {string}
 */
export function summarizeEngineeringBuffer(bytes, filename) {
  const ext = engineeringExt(filename);
  const name = String(filename || "file").split(/[\\/]/).pop();
  const header = `Engineering file "${name}" (${familyOf(ext)}).`;
  let body = "";
  try {
    if (ext === "stl") body = summarizeStl(bytes);
    else if (ext === "obj") body = summarizeObj(decodeText(bytes));
    else if (ext === "ply") body = summarizePly(decodeText(bytes));
    else if (ext === "gltf") body = summarizeGltfJson(JSON.parse(decodeText(bytes)));
    else if (ext === "glb") body = summarizeGlb(bytes);
    else if (ext === "step" || ext === "stp") body = summarizeStep(decodeText(bytes));
    else if (ext === "iges" || ext === "igs") body = summarizeIges(decodeText(bytes));
    else if (ext === "dxf") body = summarizeDxf(decodeText(bytes));
    else if (ext === "gcode" || ext === "nc" || ext === "tap") body = summarizeGcode(decodeText(bytes));
    else if (ext === "scad") body = summarizeScad(decodeText(bytes));
    else body = genericBrief(name, ext, bytes);
  } catch {
    body = genericBrief(name, ext, bytes);
  }
  const out = `${header}\n${body}`.trim();
  return out.length > MAX_BRIEF_CHARS ? `${out.slice(0, MAX_BRIEF_CHARS)}\n…` : out;
}

export async function summarizeEngineeringFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf.slice(0, MAX_PARSE_BYTES));
  return summarizeEngineeringBuffer(bytes, file.name || "file");
}
