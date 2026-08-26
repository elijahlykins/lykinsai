export class CalendarAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalendarAuthError';
    this.isAuthError = true;
    this.isUserFacing = true;
  }
}
