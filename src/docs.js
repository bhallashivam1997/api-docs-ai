import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import { HttpError } from './errors.js';

const SPEC_PATH = fileURLToPath(new URL('../docs/openapi.yaml', import.meta.url));

// Re-read the spec only when the file changes, so a freshly generated
// docs/openapi.yaml shows up without restarting the server.
let cached = { mtimeMs: -1, spec: null };

function loadSpec() {
  let mtimeMs;
  try {
    ({ mtimeMs } = statSync(SPEC_PATH));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (mtimeMs !== cached.mtimeMs) {
    cached = { mtimeMs, spec: parse(readFileSync(SPEC_PATH, 'utf8')) };
  }
  return cached.spec;
}

export const docsRouter = Router();

docsRouter.use((req, res, next) => {
  const spec = loadSpec();
  if (!spec) {
    throw new HttpError(
      404,
      'docs_not_generated',
      'docs/openapi.yaml does not exist yet. Run `npm run docs:generate` to create it.',
    );
  }
  res.locals.spec = spec;
  next();
});

docsRouter.use(swaggerUi.serve);
docsRouter.get('/', (req, res, next) => swaggerUi.setup(res.locals.spec)(req, res, next));
