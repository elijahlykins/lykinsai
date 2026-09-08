/**
 * Glass overlay: freeze an in-flight turn as Paused when the Mac sleeps
 * or shuts off. Display-off is not this path - main keeps the process awake.
 */

export function paintPausedAnswer({
  currentHasText,
  currentAnswerEl,
  updateAnswer,
}) {
  if (!currentAnswerEl) return;
  if (!currentHasText) {
    updateAnswer("Paused.");
    return;
  }
}

export function pauseOverlayTurn({
  busy,
  answerStillWorking,
  currentHasText,
  currentAnswerEl,
  updateAnswer,
  setBusy,
  stopStatusRotation,
  clearBuildingUnder,
  thinkingTimeline,
}) {
  if (!busy && !answerStillWorking) return false;
  stopStatusRotation?.();
  thinkingTimeline?.reset?.();
  clearBuildingUnder?.();
  paintPausedAnswer({ currentHasText, currentAnswerEl, updateAnswer });
  setBusy(false, { keepQueue: true });
  return true;
}
