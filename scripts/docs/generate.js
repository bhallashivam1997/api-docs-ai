// Generates docs/openapi.yaml: one Gemini call per operation, every answer checked
// before it is written.
//
//   npm run docs:generate                 all operations (needs GEMINI_API_KEY in .env)
//   npm run docs:dry-run                  list operations and print the prompts, no API call
//   npm run docs:check                    exit 1 if docs/openapi.yaml is stale; no API call
//   node scripts/docs/generate.js --only "POST /users"   one operation, printed, not written
//
// Operations whose code and prompt are unchanged reuse the answer cached in
// docs/openapi.cache.json, so a rerun on unchanged code makes no Gemini calls.
//
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-3.6-flash),
//      GEMINI_THINKING_LEVEL (MINIMAL | LOW | MEDIUM | HIGH, default MEDIUM).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { stringify } from 'yaml';
import { extractOperations } from './extract-routes.js';
import { RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, buildUserContent } from './prompt.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
dotenv.config({ path: `${REPO_ROOT}.env`, quiet: true });

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || 'MEDIUM').toUpperCase();
const MAX_ATTEMPTS = 2; // first answer + one repair turn that quotes the failed checks
const OUTPUT = 'docs/openapi.yaml';
// Validated Gemini answers keyed by operation, with a hash of everything that went into the
// prompt. Commit it with the spec: it is what makes reruns free and docs:check possible.
const CACHE = 'docs/openapi.cache.json';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Gemini drops keywords it does not support, so check its answer against the full schema here.
const checkEnvelope = ajv.compile(RESPONSE_SCHEMA);

const ajvErrors = (errors) => ajv.errorsText(errors, { separator: '; ' });

function parseJsonField(label, text, problems) {
  try {
    return JSON.parse(text);
  } catch (err) {
    problems.push(`${label} is not valid JSON: ${err.message}`);
    return undefined;
  }
}

// Parse a { schema, example } pair, drop $schema (implied by OpenAPI 3.1), and check the
// example against the schema.
function schemaAndExample(label, pair, problems) {
  if (pair.schema === null || pair.example === null) {
    if (pair.schema !== pair.example) problems.push(`${label}: schema and example must both be null or both be set`);
    return {};
  }
  const schema = parseJsonField(`${label} schema`, pair.schema, problems);
  const example = parseJsonField(`${label} example`, pair.example, problems);
  if (schema === undefined || example === undefined) return {};
  if (typeof schema !== 'object' || schema === null) {
    problems.push(`${label} schema must be a JSON object`);
    return {};
  }
  delete schema.$schema; // implied by OpenAPI 3.1
  delete schema.$id; // Ajv refuses to compile two schemas with the same $id
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    problems.push(`${label} schema is not a valid JSON Schema: ${err.message}`);
    return {};
  }
  if (!validate(example)) {
    problems.push(`${label} example does not match its schema: ${ajvErrors(validate.errors)}`);
  }
  return { schema, example };
}

// Returns { problems, operation } where operation is an OpenAPI Operation Object.
export function checkAnswer(op, answer) {
  const problems = [];
  if (!checkEnvelope(answer)) {
    return { problems: [`Answer does not match the response schema: ${ajvErrors(checkEnvelope.errors)}`] };
  }

  if (answer.summary.length > 50) problems.push(`summary is ${answer.summary.length} characters; the limit is 50`);
  if (answer.summary.endsWith('.')) problems.push('summary must not end with a period');

  const pathParams = [...op.openapiPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const documented = answer.parameters.filter((p) => p.in === 'path').map((p) => p.name).sort();
  if (pathParams.join() !== documented.join()) {
    problems.push(`path parameters must be exactly [${pathParams}] but the answer has [${documented}]`);
  }

  const parameters = answer.parameters.map((p) => {
    const { schema, example } = schemaAndExample(`parameter ${p.name}`, p, problems);
    if (p.in === 'path' && !p.required) problems.push(`path parameter ${p.name} must be required`);
    return { name: p.name, in: p.in, required: p.required, description: p.description, schema, example };
  });

  let requestBody;
  if (answer.requestBody) {
    const { schema, example } = schemaAndExample('requestBody', answer.requestBody, problems);
    requestBody = {
      required: answer.requestBody.required,
      description: answer.requestBody.description,
      content: { 'application/json': { schema, example } },
    };
  }

  const statuses = answer.responses.map((r) => r.status);
  if (new Set(statuses).size !== statuses.length) problems.push(`duplicate status codes: ${statuses}`);
  if (!statuses.some((s) => s >= 200 && s < 300)) problems.push('no 2xx response is documented');

  const responses = {};
  for (const r of answer.responses) {
    const { schema, example } = schemaAndExample(`response ${r.status}`, r, problems);
    responses[r.status] = schema
      ? { description: r.description, content: { 'application/json': { schema, example } } }
      : { description: r.description };
  }

  return {
    problems,
    operation: {
      operationId: answer.operationId,
      summary: answer.summary,
      description: answer.description,
      tags: [op.tag],
      ...(parameters.length && { parameters }),
      ...(requestBody && { requestBody }),
      responses,
    },
    answer,
    evidence: answer.responses.map((r) => `${r.status}: ${r.evidence}`),
  };
}

// 429 and 5xx are transient on the Gemini API ("model is experiencing high demand"),
// so retry them with exponential backoff. Anything else (bad key, bad request) fails at once.
const TRANSIENT_RETRIES = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(ai, contents, onCall) {
  for (let retry = 0; ; retry++) {
    onCall();
    try {
      return await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
      });
    } catch (err) {
      const transient = err.status === 429 || err.status >= 500;
      if (!transient || retry === TRANSIENT_RETRIES) throw err;
      const delay = 2000 * 2 ** retry;
      console.warn(`  Gemini returned ${err.status}; retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

async function documentOperation(ai, op, onCall) {
  const contents = [{ role: 'user', parts: [{ text: buildUserContent(op) }] }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await callGemini(ai, contents, onCall);

    const text = response.text;
    let answer;
    let result;
    try {
      answer = JSON.parse(text ?? '');
      result = checkAnswer(op, answer);
    } catch (err) {
      const reason = response.candidates?.[0]?.finishReason;
      result = { problems: [`Answer is not valid JSON (finish reason: ${reason ?? 'unknown'}): ${err.message}`] };
    }
    if (result.problems.length === 0) return result;

    console.warn(`  attempt ${attempt} failed:\n    - ${result.problems.join('\n    - ')}`);
    contents.push(
      { role: 'model', parts: [{ text: text ?? '' }] },
      {
        role: 'user',
        parts: [{
          text: `Your answer failed these checks:\n- ${result.problems.join('\n- ')}\n\n`
            + `Return a corrected answer for ${op.method} ${op.openapiPath}, still based only on the code above.`,
        }],
      },
    );
  }
  throw new Error(`${op.method} ${op.openapiPath}: no valid answer after ${MAX_ATTEMPTS} attempts`);
}

export function buildSpec(results) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const paths = {};
  const operationIds = new Set();
  for (const { op, operation } of results) {
    if (operationIds.has(operation.operationId)) {
      throw new Error(`Duplicate operationId ${operation.operationId} (${op.method} ${op.openapiPath})`);
    }
    operationIds.add(operation.operationId);
    (paths[op.openapiPath] ??= {})[op.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: pkg.name, version: pkg.version, description: pkg.description },
    servers: [{ url: 'http://localhost:3000', description: 'Local server (default PORT in src/server.js)' }],
    tags: [...new Set(results.map((r) => r.op.tag))].map((name) => ({ name })),
    paths,
  };
}

function inputHash(op) {
  const input = {
    model: MODEL,
    thinkingLevel: THINKING_LEVEL,
    systemInstruction: SYSTEM_INSTRUCTION,
    responseSchema: RESPONSE_SCHEMA,
    userContent: buildUserContent(op),
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { operations: {} };
    throw err;
  }
}

const renderSpec = (results) => `# Generated by scripts/docs/generate.js with ${MODEL}. Do not edit by hand; re-run npm run docs:generate.\n`
  + stringify(buildSpec(results), { lineWidth: 0 });

// Reuse a cached answer when the operation's inputs (code, prompt, schema, model) are
// unchanged and the answer still passes today's checks.
function fromCache(cache, op) {
  const entry = cache.operations[`${op.method} ${op.openapiPath}`];
  if (!entry || entry.inputHash !== inputHash(op)) return null;
  const result = checkAnswer(op, entry.answer);
  return result.problems.length === 0 ? result : null;
}

// docs:check: exit 1 unless docs/openapi.yaml is exactly what the current code would produce.
// Never calls Gemini, so it works in CI without an API key.
function check(operations) {
  const cache = readCache();
  const stale = [];
  const results = [];
  for (const op of operations) {
    const result = fromCache(cache, op);
    if (result) results.push({ op, ...result });
    else stale.push(`${op.method} ${op.openapiPath}`);
  }
  if (stale.length) {
    console.error(`Docs are out of date for: ${stale.join(', ')}. Run npm run docs:generate.`);
    return 1;
  }
  let current;
  try {
    current = readFileSync(OUTPUT, 'utf8');
  } catch {
    console.error(`${OUTPUT} is missing. Run npm run docs:generate.`);
    return 1;
  }
  if (current !== renderSpec(results)) {
    console.error(`${OUTPUT} differs from the generated output (edited by hand?). Run npm run docs:generate.`);
    return 1;
  }
  console.log(`${OUTPUT} is up to date (${operations.length} operations).`);
  return 0;
}

async function main() {
  const { values: args } = parseArgs({
    options: { 'dry-run': { type: 'boolean' }, check: { type: 'boolean' }, only: { type: 'string' } },
  });
  process.chdir(REPO_ROOT); // paths below (src/, docs/, package.json) are repo-relative

  let operations = extractOperations();
  if (args.check) {
    process.exitCode = check(operations);
    return;
  }
  if (args.only) {
    operations = operations.filter((op) => `${op.method} ${op.openapiPath}` === args.only);
    if (operations.length === 0) throw new Error(`No operation matches --only "${args.only}"`);
  }

  if (args['dry-run']) {
    console.log(`Model: ${MODEL}, thinking level: ${THINKING_LEVEL}\n`);
    for (const op of operations) {
      console.log(`=== ${op.method} ${op.openapiPath}  (modules: ${op.modules.join(', ')})`);
      console.log(buildUserContent(op), '\n');
    }
    console.log(`${operations.length} operation(s). Dry run: Gemini was not called and nothing was written.`);
    return;
  }

  const cache = readCache();
  let ai;
  let calls = 0;
  const results = [];
  for (const op of operations) {
    const key = `${op.method} ${op.openapiPath}`;
    let result = fromCache(cache, op);
    if (result) {
      console.log(`${key}: unchanged, using cached answer`);
    } else {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
      }
      ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      console.log(`${key}: documenting with ${MODEL} ...`);
      result = await documentOperation(ai, op, () => calls++);
      for (const line of result.evidence) console.log(`  ${line}`);
      if (!args.only) {
        // Save each answer as soon as it passes, so a later failure does not waste this call.
        cache.operations[key] = { inputHash: inputHash(op), answer: result.answer };
        mkdirSync('docs', { recursive: true });
        writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
      }
    }
    results.push({ op, key, ...result });
  }
  console.log(`\nGemini calls: ${calls}`);

  if (args.only) {
    // A partial run must not overwrite the full spec or cache; print the result for review instead.
    console.log(stringify(buildSpec(results), { lineWidth: 0 }));
    return;
  }

  mkdirSync('docs', { recursive: true });
  // Only current operations are kept, so removed routes drop out of the cache too.
  const operationsCache = Object.fromEntries(
    results.map((r) => [r.key, { inputHash: inputHash(r.op), answer: r.answer }]),
  );
  writeFileSync(CACHE, `${JSON.stringify({ operations: operationsCache }, null, 2)}\n`);
  writeFileSync(OUTPUT, renderSpec(results));
  console.log(`Wrote ${OUTPUT} and ${CACHE} (${results.length} operations). Check it with: npm run docs:lint`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
