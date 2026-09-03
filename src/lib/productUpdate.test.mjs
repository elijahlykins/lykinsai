import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_UPDATE,
  SEEN_PRODUCT_UPDATE_META_KEY,
  isProductUpdateSeen,
  productUpdateDismissPatch,
} from "./productUpdate.js";

test("unseen accounts still get the current product update", () => {
  assert.equal(isProductUpdateSeen(null), false);
  assert.equal(isProductUpdateSeen({}), false);
  assert.equal(isProductUpdateSeen({ [SEEN_PRODUCT_UPDATE_META_KEY]: "other" }), false);
});

test("dismissing the current id hides the product update", () => {
  const patch = productUpdateDismissPatch();
  assert.equal(isProductUpdateSeen(patch.metadata), true);
  assert.equal(patch.metadata[SEEN_PRODUCT_UPDATE_META_KEY], PRODUCT_UPDATE.id);
});
