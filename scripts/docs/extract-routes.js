// Finds every operation the app exposes by reading the source, not by running it,
// so each operation comes with the exact code that implements it.
//
// It understands the conventions this repo uses:
//   src/app.js:        import { usersRouter } from './routes/users.js';
//                      app.use('/users', usersRouter);
//   src/routes/*.js:   usersRouter.post('/', (req, res) => { ... });
// Only routers imported from ./routes/ are documented, so /docs itself is skipped.

import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const APP_FILE = 'src/app.js';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const read = (path) => readFileSync(path, 'utf8');

function relativeImports(file) {
  const source = read(file);
  const imports = [];
  for (const m of source.matchAll(/import\s+(?:\{([^}]*)\}\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
    const names = (m[1] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
    imports.push({ names, path: normalize(join(dirname(file), m[2])) });
  }
  return imports;
}

// The file plus every src/ file it imports, transitively, in first-seen order.
function dependencyClosure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const { path } of relativeImports(file)) {
    if (path.startsWith('src/')) dependencyClosure(path, seen);
  }
  return seen;
}

// Index just past the ")" that closes the "(" at `open`, skipping strings and comments.
function matchParen(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i + 1;
    }
  }
  throw new Error(`Unbalanced parentheses at offset ${open}`);
}

function toOpenApiPath(prefix, routePath) {
  const joined = `${prefix}/${routePath}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function extractOperations() {
  const appSource = read(APP_FILE);
  const routerFiles = new Map(); // router variable name -> file
  for (const { names, path } of relativeImports(APP_FILE)) {
    if (path.startsWith('src/routes/')) for (const name of names) routerFiles.set(name, path);
  }

  const operations = [];
  for (const m of appSource.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) {
    const [, prefix, routerName] = m;
    const file = routerFiles.get(routerName);
    if (!file) continue;

    const source = read(file);
    const routeCall = new RegExp(`\\b${routerName}\\.(${METHODS.join('|')})\\(\\s*(['"])([^'"]*)\\2`, 'g');
    for (const r of source.matchAll(routeCall)) {
      const open = r.index + r[0].indexOf('(');
      let end = matchParen(source, open);
      if (source[end] === ';') end++;

      const expressPath = `${prefix}/${r[3]}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
      operations.push({
        method: r[1].toUpperCase(),
        expressPath,
        openapiPath: toOpenApiPath(prefix, r[3]),
        tag: prefix.replace(/^\//, '').split('/')[0],
        handlerFile: relative('.', file),
        handlerSource: source.slice(r.index, end),
        // The whole router file (it holds helpers such as validators), what it imports,
        // and app.js, whose body parser and error handler shape every response.
        modules: [...dependencyClosure(file), APP_FILE],
      });
    }
  }
  return operations;
}
