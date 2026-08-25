import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGINE_DOWNLOAD_FORMAT_KEY,
  imagineDownloadFilename,
  imagineDownloadFilters,
  imagineDownloadOption,
  loadImagineDownloadFormat,
  saveImagineDownloadFormat,
} from "./imagineDownload.ts";

function memoryStore(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

describe("imagineDownloadOption", () => {
  it("defaults to PNG", () => {
    assert.equal(imagineDownloadOption(undefined).id, "png");
    assert.equal(imagineDownloadOption("tiff").id, "png");
  });

  it("resolves jpeg and webp", () => {
    assert.equal(imagineDownloadOption("jpeg").ext, "jpg");
    assert.equal(imagineDownloadOption("webp").mime, "image/webp");
  });
});

describe("imagineDownloadFilename", () => {
  it("uses the concept as the stem and the format as the extension", () => {
    assert.equal(imagineDownloadFilename("red bicycle", "png"), "red bicycle.png");
    assert.equal(imagineDownloadFilename("red bicycle", "jpeg"), "red bicycle.jpg");
  });

  it("strips characters a save sheet cannot use and an existing extension", () => {
    assert.equal(imagineDownloadFilename("a/b:c*.png", "webp"), "a-b-c-.webp");
  });
});

describe("imagineDownloadFilters", () => {
  it("lists every format when none is chosen yet", () => {
    const filters = imagineDownloadFilters();
    assert.deepEqual(
      filters.map((f) => f.name),
      ["PNG", "JPEG", "WebP"],
    );
  });

  it("narrows the save sheet to the picked type", () => {
    assert.deepEqual(imagineDownloadFilters("jpeg"), [
      { name: "JPEG", extensions: ["jpg", "jpeg"] },
    ]);
  });
});

describe("remembered download format", () => {
  it("round-trips through storage", () => {
    const store = memoryStore();
    assert.equal(loadImagineDownloadFormat(store), "png");
    assert.equal(saveImagineDownloadFormat("webp", store), "webp");
    assert.equal(store.getItem(IMAGINE_DOWNLOAD_FORMAT_KEY), "webp");
    assert.equal(loadImagineDownloadFormat(store), "webp");
  });
});
