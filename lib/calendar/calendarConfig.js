// Flip this to restore Google / Apple calendar connect + pull.
// Keep the client copy in src/lib/calendar/calendarConfig.js in sync.
export const EXTERNAL_CALENDAR_SYNC_ENABLED = false;

export function assertExternalCalendarSyncEnabled() {
  if (EXTERNAL_CALENDAR_SYNC_ENABLED) return;
  const error = new Error('Google and Apple calendar sync is temporarily unavailable.');
  error.isUserFacing = true;
  error.statusCode = 410;
  throw error;
}
