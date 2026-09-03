/**
 * Extension → icon and human "kind", shared by everything that lists files.
 * Finder shows a Kind column rather than a raw extension, so each rule carries
 * the label as well as the glyph.
 */

import {
  Archive,
  Binary,
  Code2,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  Image as ImageIcon,
  Link2,
  Music,
  Package,
  Presentation,
  Video,
} from "lucide-react";

const RULES = [
  {
    re: /^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?|ico|icns)$/,
    icon: ImageIcon,
    label: "Image",
  },
  { re: /^(mp4|mov|webm|m4v|mkv|avi|mpe?g|wmv)$/, icon: Video, label: "Movie" },
  { re: /^(mp3|wav|m4a|ogg|flac|aiff?|aac|midi?)$/, icon: Music, label: "Audio" },
  { re: /^pdf$/, icon: FileText, label: "PDF" },
  { re: /^(doc|docx|pages|rtf|odt)$/, icon: FileText, label: "Document" },
  { re: /^(xls|xlsx|numbers|csv|tsv|ods)$/, icon: FileSpreadsheet, label: "Spreadsheet" },
  { re: /^(ppt|pptx|key|odp)$/, icon: Presentation, label: "Presentation" },
  { re: /^(zip|tar|gz|tgz|bz2|xz|rar|7z|dmg|iso)$/, icon: Archive, label: "Archive" },
  { re: /^(html|htm)$/, icon: FileText, label: "Web Page" },
  {
    re: /^(js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cs|swift|kt|php|sh|zsh|sql|css|scss|json|yaml|yml|toml|xml)$/,
    icon: Code2,
    label: "Code",
  },
  { re: /^(txt|md|markdown|log)$/, icon: FileText, label: "Text" },
  { re: /^(exe|bin|dylib|so|o|wasm)$/, icon: Binary, label: "Binary" },
];

export function kindOf(entry) {
  if (!entry) return { icon: File, label: "Item" };
  if (entry.package) {
    return { icon: Package, label: entry.ext === "app" ? "Application" : "Package" };
  }
  if (entry.type === "dir") return { icon: Folder, label: "Folder" };
  if (entry.type === "symlink") return { icon: Link2, label: "Alias" };

  const ext = String(entry.ext || "").toLowerCase();
  for (const rule of RULES) {
    if (rule.re.test(ext)) return { icon: rule.icon, label: rule.label };
  }
  return { icon: File, label: ext ? `${ext.toUpperCase()} file` : "Document" };
}

/** Decimal units, the way the Finder's Size column counts. */
export function formatSize(bytes) {
  if (bytes == null) return "--";
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDate(ms) {
  if (!ms) return "--";
  const date = new Date(ms);
  const today = new Date();
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  if (sameDay) {
    return `Today ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString([], {
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "/Users/me/Code/app" → ["Users","me","Code","app"] with absolute paths. */
export function breadcrumbsFor(fullPath) {
  const parts = String(fullPath || "").split("/").filter(Boolean);
  const crumbs = [];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}
