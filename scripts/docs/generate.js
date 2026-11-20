// Generates docs/openapi.yaml: one Gemini call per operation, every answer checked
// before it is written.
//
//   npm run docs:generate                 all operations (needs GEMINI_API_KEY in .env)
//   npm run docs:dry-run                  list operations and print the prompts, no API call
//   npm run docs:check                    exit 1 if docs/openapi.yaml is stale; no API call
//   node scripts/docs/generate.js --only "POST /users"   one operation, printed, not written
//   --force    ignore the cache and regenerate every operation
//   --report F with docs:check, write the stale operations as a Markdown table to F;
//              with docs:generate, write the regenerated operations as a Markdown list to F
//
// Operations whose code and prompt are unchanged reuse the answer cached in
// docs/openapi.cache.json, so a rerun on unchanged code makes no Gemini calls.
//
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-3.6-flash),
//      GEMINI_FALLBACK_MODELS (comma-separated, tried when the model is unavailable),
//      GEMINI_THINKING_LEVEL (MINIMAL | LOW | MEDIUM | HIGH, default MEDIUM).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
// Tried in order when the previous model stays unavailable (429/5xx) after retries.
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
const MODELS = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
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
const isTransient = (err) => err.status === 429 || err.status >= 500;

async function callGemini(ai, model, contents, onCall) {
  for (let retry = 0; ; retry++) {
    onCall();
    try {
      return await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
      });
    } catch (err) {
      if (!isTransient(err) || retry === TRANSIENT_RETRIES) throw err;
      const delay = 2000 * 2 ** retry;
      console.warn(`  ${model} returned ${err.status}; retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

// One model: first answer plus a repair turn. Throws if the answer still fails the checks.
async function documentWithModel(ai, model, op, onCall) {
  const contents = [{ role: 'user', parts: [{ text: buildUserContent(op) }] }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await callGemini(ai, model, contents, onCall);

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
    if (result.problems.length === 0) return { ...result, model };

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
  throw new Error(`${op.method} ${op.openapiPath}: no valid answer from ${model} after ${MAX_ATTEMPTS} attempts`);
}

// Fall back to the next model only when one is unavailable (429/5xx after retries).
// An answer that fails the checks is a quality problem, so it stops the run instead.
async function documentOperation(ai, op, onCall) {
  for (const [i, model] of MODELS.entries()) {
    try {
      console.log(`  using ${model}`);
      return await documentWithModel(ai, model, op, onCall);
    } catch (err) {
      if (!isTransient(err) || i === MODELS.length - 1) throw err;
      console.warn(`  ${model} is unavailable (${err.status}); falling back to ${MODELS[i + 1]}`);
    }
  }
  throw new Error('unreachable');
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

// The model is part of the hash, so a cached answer is tied to the model that wrote it.
function inputHash(op, model) {
  const input = {
    model,
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

const writeCache = (cache) => writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);

function renderSpec(results) {
  const models = [...new Set(results.map((r) => r.model))].sort().join(', ');
  return `# Generated by scripts/docs/generate.js with ${models}. Do not edit by hand; re-run npm run docs:generate.\n`
    + stringify(buildSpec(results), { lineWidth: 0 });
}

// Look up an operation's cached answer. Any model's answer is reused as long as the code and
// prompt are unchanged, so a fallback answer written in CI does not churn on a local rerun
// (use --force to regenerate). Returns { result } or { reason } explaining why it is stale.
function fromCache(cache, op) {
  const entry = cache.operations[`${op.method} ${op.openapiPath}`];
  if (!entry) return { reason: 'Not generated yet' };
  if (entry.inputHash !== inputHash(op, entry.model)) return { reason: 'Route code or prompt changed' };
  const result = checkAnswer(op, entry.answer);
  if (result.problems.length) return { reason: `Cached answer fails current checks: ${result.problems[0]}` };
  return { result: { ...result, model: entry.model } };
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

// docs:check: exit 1 unless docs/openapi.yaml is exactly what the current code would produce.
// Never calls Gemini, so it works in CI without an API key. With --report, writes the stale
// operations as a Markdown table (for a CI job summary).
function check(operations, reportPath) {
  const cache = readCache();
  const stale = [];
  const results = [];
  for (const op of operations) {
    const { result, reason } = fromCache(cache, op);
    if (result) results.push({ op, ...result });
    else stale.push([`${op.method} ${op.openapiPath}`, reason]);
  }
  const current = new Set(operations.map((op) => `${op.method} ${op.openapiPath}`));
  for (const key of Object.keys(cache.operations)) {
    if (!current.has(key)) stale.push([key, 'Route removed from code but still documented']);
  }

  if (!stale.length) {
    let spec = null;
    try {
      spec = readFileSync(OUTPUT, 'utf8');
    } catch {
      stale.push([OUTPUT, 'File is missing']);
    }
    if (spec !== null && spec !== renderSpec(results)) {
      stale.push([OUTPUT, 'Differs from the generated output (edited by hand?)']);
    }
  }

  if (!stale.length) {
    console.log(`${OUTPUT} is up to date (${operations.length} operations).`);
    return 0;
  }
  const table = ['| Operation | Why it is stale |', '| --- | --- |',
    ...stale.map(([key, reason]) => `| \`${cell(key)}\` | ${cell(reason)} |`)].join('\n');
  console.error(`${OUTPUT} is out of date. Run npm run docs:generate.\n\n${table}`);
  if (reportPath) writeFileSync(reportPath, `${table}\n`);
  return 1;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      check: { type: 'boolean' },
      force: { type: 'boolean' },
      only: { type: 'string' },
      report: { type: 'string' },
    },
  });
  if (args.report) args.report = resolve(args.report); // relative to where the command ran
  process.chdir(REPO_ROOT); // paths below (src/, docs/, package.json) are repo-relative

  let operations = extractOperations();
  if (args.check) {
    process.exitCode = check(operations, args.report);
    return;
  }
  if (args.only) {
    operations = operations.filter((op) => `${op.method} ${op.openapiPath}` === args.only);
    if (operations.length === 0) throw new Error(`No operation matches --only "${args.only}"`);
  }

  if (args['dry-run']) {
    console.log(`Models: ${MODELS.join(' -> ')}, thinking level: ${THINKING_LEVEL}\n`);
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
  const regenerated = [];
  for (const op of operations) {
    const key = `${op.method} ${op.openapiPath}`;
    let { result } = args.force ? {} : fromCache(cache, op);
    if (result) {
      console.log(`${key}: unchanged, using cached answer from ${result.model}`);
    } else {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
      }
      ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      console.log(`${key}: documenting ...`);
      result = await documentOperation(ai, op, () => calls++);
      for (const line of result.evidence) console.log(`  ${line}`);
      regenerated.push(`${key} (${result.model})`);
      if (!args.only) {
        // Save each answer as soon as it passes, so a later failure does not waste this call.
        cache.operations[key] = { model: result.model, inputHash: inputHash(op, result.model), answer: result.answer };
        mkdirSync('docs', { recursive: true });
        writeCache(cache);
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
  writeCache({
    operations: Object.fromEntries(results.map((r) => [r.key, {
      model: r.model, inputHash: inputHash(r.op, r.model), answer: r.answer,
    }])),
  });
  writeFileSync(OUTPUT, renderSpec(results));
  console.log(`Wrote ${OUTPUT} and ${CACHE} (${results.length} operations). Check it with: npm run docs:lint`);

  if (args.report) {
    // One line per regenerated operation, for the CI comment.
    writeFileSync(args.report, regenerated.map((line) => `- \`${line.replace(' (', '` (')}\n`).join(''));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
