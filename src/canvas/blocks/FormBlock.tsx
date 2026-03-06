import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Plus, Trash2, ChevronDown, X, ClipboardList, GripVertical, Pencil } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { snapToGrid } from "@/canvas/utils/snap";

type FieldType = "text" | "textarea" | "number" | "email" | "select" | "checkbox" | "date";
type Field = { id: string; type: FieldType; label: string; placeholder?: string; required?: boolean; options?: string[] };
type FormData = { title: string; description: string; fields: Field[]; submitLabel: string };

const uid = () => Math.random().toString(36).slice(2, 9);

const DEFAULT_FORM: FormData = {
  title: "Contact Form",
  description: "",
  fields: [
    { id: uid(), type: "text", label: "Name", placeholder: "Enter your name", required: true },
    { id: uid(), type: "email", label: "Email", placeholder: "you@example.com", required: true },
    { id: uid(), type: "textarea", label: "Message", placeholder: "Your message...", required: false },
  ],
  submitLabel: "Submit",
};

function parseForm(content: string): FormData {
  try {
    const d = JSON.parse(content);
    return { title: d.title || "Form", description: d.description || "", fields: d.fields || DEFAULT_FORM.fields, submitLabel: d.submitLabel || "Submit" };
  } catch {
    return { ...DEFAULT_FORM, fields: DEFAULT_FORM.fields.map((f) => ({ ...f, id: uid() })) };
  }
}

const FIELD_TYPES: { id: FieldType; label: string; icon: string }[] = [
  { id: "text", label: "Text", icon: "Aa" },
  { id: "textarea", label: "Long Text", icon: "\u00B6" },
  { id: "number", label: "Number", icon: "#" },
  { id: "email", label: "Email", icon: "@" },
  { id: "select", label: "Dropdown", icon: "\u25BE" },
  { id: "checkbox", label: "Checkbox", icon: "\u2611" },
  { id: "date", label: "Date", icon: "\uD83D\uDCC5" },
];

export const FormBlock = memo(function FormBlock({ id }: { id: string }) {
  const block = useCanvasStore((s) => s.blocks[id]) as any;
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const gridSize = 24;

  const resizeRef = useRef<any>(null);
  const endResizeCleanupRef = useRef<(() => void) | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const form = useMemo(() => parseForm(String(block?.content ?? "")), [block?.content]);

  const style = useMemo(() => {
    if (!block || block.format !== "form") return null;
    return { position: "absolute" as const, left: `${block.x}px`, top: `${block.y}px`, width: `${block.width}px`, height: `${block.height}px` };
  }, [block]);

  if (!block || block.format !== "form" || !style) return null;

  const save = (patch: Partial<FormData>) => {
    const next = { ...form, ...patch };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(next) } as any);
  };

  const snapSize = (n: number) => Math.max(gridSize, snapToGrid(n, gridSize));

  const endResize = (pointerId: number) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    if (endResizeCleanupRef.current) { try { endResizeCleanupRef.current(); } catch {} endResizeCleanupRef.current = null; }
    if (r.capturer) { try { r.capturer.releasePointerCapture(pointerId); } catch {} }
    resizeRef.current = null;
  };

  const beginResize = (e: React.PointerEvent, mode: "right" | "bottom" | "corner") => {
    e.stopPropagation(); e.preventDefault(); bringToFront(id);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) endResize(e.pointerId); };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    endResizeCleanupRef.current = () => { window.removeEventListener("pointerup", onUp, true); window.removeEventListener("pointercancel", onUp, true); };
    resizeRef.current = { mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origW: block.width, origH: block.height, raf: null, capturer: el };
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    if (r.raf != null) window.cancelAnimationFrame(r.raf);
    const dx = e.clientX - r.startX; const dy = e.clientY - r.startY;
    r.raf = window.requestAnimationFrame(() => {
      updateBlock(id, { width: r.mode !== "bottom" ? snapSize(r.origW + dx) : r.origW, height: r.mode !== "right" ? snapSize(r.origH + dy) : r.origH } as any);
    });
  };

  const renderFieldPreview = (field: Field) => {
    const inputCls = "w-full rounded-lg border border-black/8 px-3 py-2 text-[12px] bg-gray-50/40 outline-none text-black/60 placeholder:text-black/25";
    switch (field.type) {
      case "textarea":
        return <textarea className={`${inputCls} resize-none`} rows={3} placeholder={field.placeholder} readOnly />;
      case "number":
        return <input type="number" className={inputCls} placeholder={field.placeholder} readOnly />;
      case "email":
        return <input type="email" className={inputCls} placeholder={field.placeholder} readOnly />;
      case "date":
        return <input type="date" className={inputCls} readOnly />;
      case "checkbox":
        return (
          <label className="flex items-center gap-2.5 text-[12px] text-black/60 py-1">
            <input type="checkbox" className="rounded w-4 h-4 accent-blue-500" disabled /> {field.placeholder || field.label}
          </label>
        );
      case "select":
        return (
          <div className="relative">
            <select className={`${inputCls} appearance-none pr-8`} disabled>
              <option>{field.placeholder || "Select..."}</option>
              {field.options?.map((o, i) => <option key={i}>{o}</option>)}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-black/25 pointer-events-none" />
          </div>
        );
      default:
        return <input type="text" className={inputCls} placeholder={field.placeholder} readOnly />;
    }
  };

  return (
    <div data-canvas-block data-block-id={id} style={style} className="group" onPointerDown={() => bringToFront(id)}>
      <div className="w-full h-full rounded-lg border border-black/10 bg-white shadow-md flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-black/5 shrink-0" style={{ background: "rgba(0,0,0,0.015)" }} onPointerDown={(e) => e.stopPropagation()}>
          <input className="flex-1 text-[13px] font-semibold bg-transparent outline-none text-black/80 placeholder:text-black/30" value={form.title} onChange={(e) => save({ title: e.target.value })} placeholder="Form title" />
          <span className="text-[10px] text-black/30 font-medium">{form.fields.length} fields</span>
        </div>

        {/* Form preview — click overlay to edit */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 relative" onPointerDown={(e) => e.stopPropagation()}>
          {form.description && <p className="text-[11px] text-black/40">{form.description}</p>}

          {form.fields.map((field) => (
            <div key={field.id} className="space-y-1">
              <label className="text-[12px] font-medium text-black/65">
                {field.label}{field.required && <span className="text-red-400 ml-0.5">*</span>}
              </label>
              {renderFieldPreview(field)}
            </div>
          ))}

          <button type="button" className="w-full py-2 rounded-lg bg-blue-500 text-white text-[12px] font-medium hover:bg-blue-600 transition-colors mt-1">
            {form.submitLabel}
          </button>
          <div className="absolute inset-0 cursor-pointer z-[1]" onPointerUp={(e) => { if (e.button === 0) { e.stopPropagation(); setEditorOpen(true); } }} />
        </div>
      </div>

      {/* Form editor modal — portaled to body */}
      {editorOpen && ReactDOM.createPortal(
        <FormEditorModal form={form} onSave={save} onClose={() => setEditorOpen(false)} />,
        document.body,
      )}

      {/* Resize handles */}
      <div data-resize-handle className="absolute top-0 right-0 h-full w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-r" onPointerDown={(e) => beginResize(e, "right")} onPointerMove={onResizeMove} />
      <div data-resize-handle className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize opacity-0 group-hover:opacity-100 hover:bg-blue-400/20 transition-opacity rounded-b" onPointerDown={(e) => beginResize(e, "bottom")} onPointerMove={onResizeMove} />
      <div data-resize-handle className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity z-10" onPointerDown={(e) => beginResize(e, "corner")} onPointerMove={onResizeMove}>
        <svg viewBox="0 0 16 16" className="w-full h-full text-black/25"><path d="M14 14L6 14M14 14L14 6M14 14L8 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      </div>
    </div>
  );
});

/* ─── Form Editor Modal ──────────────────────────────────────────────────── */

function FormEditorModal({ form, onSave, onClose }: {
  form: FormData;
  onSave: (patch: Partial<FormData>) => void;
  onClose: () => void;
}) {
  const [expandedField, setExpandedField] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const updateField = (fid: string, patch: Partial<Field>) => {
    onSave({ fields: form.fields.map((f) => f.id === fid ? { ...f, ...patch } : f) });
  };

  const addField = (type: FieldType = "text") => {
    const newId = uid();
    onSave({ fields: [...form.fields, { id: newId, type, label: "New Field", placeholder: "", required: false, options: type === "select" ? ["Option 1", "Option 2"] : undefined }] });
    setExpandedField(newId);
  };

  const removeField = (fid: string) => {
    onSave({ fields: form.fields.filter((f) => f.id !== fid) });
    if (expandedField === fid) setExpandedField(null);
  };

  const duplicateField = (fid: string) => {
    const idx = form.fields.findIndex((f) => f.id === fid);
    if (idx === -1) return;
    const orig = form.fields[idx];
    const copy = { ...orig, id: uid() };
    const next = [...form.fields];
    next.splice(idx + 1, 0, copy);
    onSave({ fields: next });
  };

  const getTypeInfo = (type: FieldType) => FIELD_TYPES.find((t) => t.id === type) || FIELD_TYPES[0];

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[1000] flex items-center justify-center" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
        <div className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} style={{ animation: "formModalIn 0.15s ease-out" }}>
          {/* Header */}
          <div className="flex items-center gap-3 px-5 pt-5 pb-3">
            <ClipboardList className="w-4.5 h-4.5 text-black/35 shrink-0" />
            <div className="flex-1 min-w-0">
              <input className="w-full text-base font-semibold bg-transparent outline-none text-black/85 placeholder:text-black/30" value={form.title} onChange={(e) => onSave({ title: e.target.value })} placeholder="Form title" autoFocus />
              <div className="text-[11px] text-black/35">{form.fields.length} fields</div>
            </div>
            <button type="button" className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-black/5 text-black/35 hover:text-black/60 transition-colors shrink-0" onClick={onClose}>
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Description + Submit label */}
          <div className="px-5 pb-3 space-y-2">
            <input className="w-full text-[12px] text-black/50 bg-transparent outline-none placeholder:text-black/25" placeholder="Form description (optional)" value={form.description} onChange={(e) => onSave({ description: e.target.value })} />
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-black/40 font-medium shrink-0">Button text:</span>
              <input className="text-[12px] text-black/65 bg-transparent outline-none border-b border-black/8 focus:border-blue-400/40 py-0.5 flex-1" value={form.submitLabel} onChange={(e) => onSave({ submitLabel: e.target.value })} />
            </div>
          </div>

          {/* Fields list */}
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[11px] font-semibold text-black/45 uppercase tracking-wide">Fields</span>
            </div>

            <div className="space-y-1.5">
              {form.fields.map((field) => {
                const typeInfo = getTypeInfo(field.type);
                const isExpanded = expandedField === field.id;
                return (
                  <div key={field.id} className="rounded-lg border border-black/6 overflow-hidden transition-all" style={{ background: isExpanded ? "rgba(0,0,0,0.01)" : "#fff" }}>
                    {/* Field row */}
                    <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={() => setExpandedField(isExpanded ? null : field.id)}>
                      <span className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] bg-black/4 text-black/40 font-medium shrink-0">{typeInfo.icon}</span>
                      <span className="flex-1 text-[12px] font-medium text-black/70 truncate">{field.label}</span>
                      {field.required && <span className="text-[9px] font-semibold text-red-400 bg-red-50 px-1.5 py-0.5 rounded-full shrink-0">REQ</span>}
                      <span className="text-[10px] text-black/30 shrink-0">{typeInfo.label}</span>
                      <button type="button" className="w-5 h-5 flex items-center justify-center rounded text-black/20 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0" onClick={(e) => { e.stopPropagation(); removeField(field.id); }}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Expanded editor */}
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-2 border-t border-black/5 pt-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-black/40 font-medium w-14 shrink-0">Label</span>
                          <input className="flex-1 text-[12px] text-black/70 bg-transparent outline-none border-b border-black/8 focus:border-blue-400/40 py-0.5" value={field.label} onChange={(e) => updateField(field.id, { label: e.target.value })} />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-black/40 font-medium w-14 shrink-0">Type</span>
                          <div className="flex flex-wrap gap-1">
                            {FIELD_TYPES.map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${field.type === t.id ? "bg-blue-500/15 text-blue-600 font-medium" : "text-black/40 bg-black/3 hover:bg-black/6"}`}
                                onClick={() => updateField(field.id, { type: t.id, options: t.id === "select" && !field.options ? ["Option 1", "Option 2"] : field.options })}
                              >
                                {t.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {field.type !== "checkbox" && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-black/40 font-medium w-14 shrink-0">Hint</span>
                            <input className="flex-1 text-[12px] text-black/50 bg-transparent outline-none border-b border-black/8 focus:border-blue-400/40 py-0.5 placeholder:text-black/25" placeholder="Placeholder text" value={field.placeholder || ""} onChange={(e) => updateField(field.id, { placeholder: e.target.value })} />
                          </div>
                        )}
                        {field.type === "select" && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-black/40 font-medium w-14 shrink-0">Options</span>
                            <input className="flex-1 text-[12px] text-black/50 bg-transparent outline-none border-b border-black/8 focus:border-blue-400/40 py-0.5 placeholder:text-black/25" placeholder="Comma separated" value={(field.options || []).join(", ")} onChange={(e) => updateField(field.id, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                          </div>
                        )}
                        <div className="flex items-center gap-3 pt-1">
                          <label className="flex items-center gap-1.5 text-[11px] text-black/50 cursor-pointer">
                            <input type="checkbox" checked={field.required || false} onChange={(e) => updateField(field.id, { required: e.target.checked })} className="rounded w-3.5 h-3.5 accent-blue-500" /> Required
                          </label>
                          <button type="button" className="text-[11px] text-blue-500 hover:text-blue-600 font-medium" onClick={() => duplicateField(field.id)}>Duplicate</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add field */}
            <div className="mt-3">
              <div className="text-[10px] text-black/30 font-medium mb-1.5">ADD FIELD</div>
              <div className="flex flex-wrap gap-1">
                {FIELD_TYPES.map((t) => (
                  <button key={t.id} type="button" className="flex items-center gap-1.5 text-[11px] text-black/50 hover:text-blue-500 bg-black/3 hover:bg-blue-50/50 px-2.5 py-1.5 rounded-lg transition-colors" onClick={() => addField(t.id)}>
                    <span className="text-[10px]">{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes formModalIn { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }`}</style>
    </>
  );
}
