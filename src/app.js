import express from 'express';
import { HttpError } from './errors.js';
import { healthRouter } from './routes/health.js';
import { usersRouter } from './routes/users.js';

export function createApp() {
  const app = express();

  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/users', usersRouter);

  // Nothing matched: unknown route.
  app.use((req, res, next) => {
    next(new HttpError(404, 'not_found', `Route ${req.method} ${req.path} not found`));
  });

  // Single error handler. Every error response has the shape:
  // { "error": { "code": "...", "message": "..." } }
  app.use((err, req, res, next) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';

    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err.type === 'entity.parse.failed') {
      // Thrown by express.json() for malformed JSON.
      status = 400;
      code = 'invalid_json';
      message = 'Request body is not valid JSON';
    } else if (err.status >= 400 && err.status < 500) {
      // Other client errors from express.json(), e.g. body too large.
      status = err.status;
      code = 'bad_request';
      message = err.message;
    } else {
      console.error(err);
    }

    res.status(status).json({ error: { code, message } });
  });

  return app;
}
