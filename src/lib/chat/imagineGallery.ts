/**
 * Imagine edit overlay: prev/next walks every finished image in the chat,
 * not only the four slots in the batch that is open.
 */

export type ImagineGallerySlot = {
  status?: string;
  url?: string | null;
};

export type ImagineGalleryBatch = {
  id: string;
  slots: ImagineGallerySlot[];
};

export type ImagineGalleryCursor = {
  batchId: string;
  index: number;
};

export function imagineDoneGallery(batches: ImagineGalleryBatch[]): ImagineGalleryCursor[] {
  const out: ImagineGalleryCursor[] = [];
  for (const batch of batches || []) {
    const slots = Array.isArray(batch.slots) ? batch.slots : [];
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      if (slot?.status === "done" && slot.url) {
        out.push({ batchId: batch.id, index });
      }
    }
  }
  return out;
}

export function stepImagineGallery(
  gallery: ImagineGalleryCursor[],
  current: ImagineGalleryCursor | null | undefined,
  dir: 1 | -1,
): ImagineGalleryCursor | null {
  if (!gallery || gallery.length < 2) return null;
  const pos = current
    ? gallery.findIndex((item) => item.batchId === current.batchId && item.index === current.index)
    : -1;
  const from = pos >= 0 ? pos : 0;
  return gallery[(from + dir + gallery.length) % gallery.length];
}
