// An error that maps directly to an HTTP response.
// Kept in its own module so routes can import it without importing app.js.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
