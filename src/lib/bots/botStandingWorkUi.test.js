import test from "node:test";
import assert from "node:assert/strict";

import { BOT_STANDING_WORK_UI, botStandingWorkUiEnabled } from "./botStandingWorkUi.js";

test("teach-a-task and routines UI stays off until launch", () => {
  assert.equal(BOT_STANDING_WORK_UI, false);
  assert.equal(botStandingWorkUiEnabled(), false);
});
