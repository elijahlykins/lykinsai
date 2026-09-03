// Teach-a-task and Routines on the Bots UI.
// The runtime (create_routine, teach service, Activity) stays wired so chat
// and later launch still work. Flip this to true when the surfaces ship.

export const BOT_STANDING_WORK_UI = false;

export function botStandingWorkUiEnabled() {
  return BOT_STANDING_WORK_UI === true;
}
