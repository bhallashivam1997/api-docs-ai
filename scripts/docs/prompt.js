/*
 * Gemini prompt for documenting one API operation (one call per operation).
 *
 * Sources, all read 2026-11-21 (ai.google.dev pages now redirect to aistudio.google.com/docs):
 *
 * 1. Gemini models: https://aistudio.google.com/docs/models
 *    `gemini-3.6-flash` is a pinned "Stable" model ID. Pinned IDs do not change under us,
 *    unlike `*-latest` aliases, so regenerating the spec is reproducible. (gemini-3.8-flash,
 *    also stable, returned 503 "high demand" on every call on 2026-11-21.) The Gemini 4 cards
 *    carry no stability badge, so they are opt-in through GEMINI_MODEL.
 * 2. Thinking: https://aistudio.google.com/docs/thinking
 *    gemini-3.6-flash supports minimal / low / medium / high. The guide says to pick "the lowest
 *    thinking_level that meets your quality bar" and warns that xhigh can overthink JSON
 *    extraction. We use MEDIUM: tracing every status code through helper functions is
 *    multi-step reasoning, but it is not a hard research problem.
 * 3. Prompt design: https://aistudio.google.com/docs/prompting-strategies
 *    - Persona, behavioural constraints and output-format rules go in the system instruction.
 *    - Gemini 3.x: be precise and direct, define ambiguous terms, keep one delimiter style
 *      (XML tags here) for the whole prompt.
 *    - Long inputs: data first, the task at the very end, anchored with "Based on ...".
 *    - Always include few-shot examples, formatted consistently, but not so many that the model
 *      overfits. One example for a made-up endpoint teaches style without lending content.
 *    - Grounding clause modelled on the guide's "strictly grounded" system instruction:
 *      if the code does not show it, leave it out.
 *    - Gemini 3.6+ ignores temperature / top_p / top_k (deprecated, future 400s), so the
 *      generator sets none. Determinism comes from explicit rules here, as the guide recommends.
 *    - Do not ask for step-by-step reasoning in the output; the model thinks internally.
 * 4. Structured output: https://aistudio.google.com/docs/structured-output and the
 *    `responseJsonSchema` doc comment in @google/genai (dist/genai.d.ts)
 *    - `responseMimeType: 'application/json'` + `responseJsonSchema`. The SDK says use the
 *      JSON Schema field when `responseSchema` (OpenAPI 3.0 subset) does not process a schema
 *      correctly, and the API reference calls `responseSchema` an internal detail.
 *    - "Use the description field to guide the model": field-level rules live in the schema's
 *      descriptions, and the prompt text does not restate the schema.
 *    - Unsupported keywords (pattern, minLength, ...) are silently dropped and output can be
 *      schema-valid but wrong, so the generator validates every response with Ajv.
 *    - Arbitrary nested JSON Schemas are hard to express in the supported subset (recursion
 *      only through optional fields), so schemas and examples are returned as JSON strings and
 *      parsed and checked by the generator.
 * 5. OpenAPI 3.1.1: https://spec.openapis.org/oas/v3.1.1.html
 *    Operation `summary` is "a short summary", `description` "a verbose explanation"; every
 *    Response needs a `description`; examples "SHOULD match the specified schema"; the Schema
 *    `example` keyword is deprecated, so the generator writes examples on the Media Type object.
 * 6. OpenAPI documentation guide: https://learn.openapis.org/specification/docs.html
 *    Summaries appear in list views and should be short. Parameter descriptions should add
 *    purpose and effect, not repeat name/type/range already in the schema.
 */

import { readFileSync } from 'node:fs';

export const SYSTEM_INSTRUCTION = `<role>
You are a technical writer documenting a small HTTP JSON API for engineers who are integrating with it for the first time. They have never seen the source code. They need to know what to send, what comes back, and what they can do wrong.
</role>

<grounding>
You are given the source code of one operation. Document only behaviour that this code shows.
- Do not mention authentication, authorisation, rate limits, pagination, caching, idempotency, retries, webhooks or side effects unless the code implements them.
- If the code does not show something, leave it out. Do not guess, and do not describe how APIs usually behave.
- "The code" means the handler, the src/ modules it imports, and the application setup in src/app.js (body parsing, routing and the error handler that turns thrown errors into responses).
</grounding>

<status_codes>
List exactly the status codes a caller of this operation can receive, no more and no fewer.
- Include a code only if you can point to the line that produces it: an explicit status in the handler, an error thrown by the handler or a module it calls, or a request-body error that the application setup turns into a response.
- Include request-body parsing errors only for operations that read a request body.
- Leave out the generic 500 fallback for unexpected exceptions; a caller cannot trigger it on purpose.
- Describe each code from the caller's point of view: what about their request, or the current data, causes it.
- When one code has several causes, name each cause in that code's description.
</status_codes>

<schemas_and_examples>
- Derive every schema from the code: field names, types, required fields, enums, defaults, length limits and formats that the code enforces or produces. Use JSON Schema 2020-12.
- Error bodies follow the shape the error handler writes.
- Give one realistic example per request body and per response. Each example must be valid against its schema.
- Keep data consistent within the operation: the values in the request example and path parameters reappear unchanged in the response examples, normalised only as the code normalises them.
- No placeholder values such as "string", "foo", "test" or "John Doe", and no real personal data. Use invented names and email addresses at example.com. Generated IDs and timestamps must have the format the code produces.
- Error examples use the exact code and message strings from the source.
</schemas_and_examples>

<writing_rules>
- summary: a short imperative phrase of 50 characters or fewer, no trailing period. Example: "Archive a project".
- description: 1 to 3 plain sentences. Say what the operation does, then state the rules a caller can break (required fields, allowed values, uniqueness, limits). No marketing language, no headings, no lists.
- Parameter and response descriptions: one sentence each. A parameter description says what the value identifies or controls; do not repeat its name or type.
- Use the field names exactly as they appear in the code, in backticks.
</writing_rules>

<worked_example>
This example is for a made-up endpoint that is not part of this API. Copy its style, not its content.

Input code:
projectsRouter.post('/:projectId/archive', (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) throw new HttpError(404, 'not_found', 'Project not found');
  if (project.archivedAt) throw new HttpError(409, 'already_archived', 'Project is already archived');
  res.status(200).json(archiveProject(project));
});

Resulting documentation text:
- summary: Archive a project
- description: Marks the project as archived and returns it with \`archivedAt\` set. A project can be archived only once.
- parameter projectId: ID of the project to archive, as returned when the project was created.
- 200: The project was archived; the body is the updated project.
- 404: No project exists with this \`projectId\`.
- 409: The project is already archived.
- Example values: projectId "5f0c2a8e-3b1d-4c6f-9a7e-2d8b1c4e6f30", name "Q3 hiring plan", archivedAt "2026-03-04T09:15:00.000Z".
</worked_example>`;

const fence = (path, source) => `<file path="${path}">\n${source.trimEnd()}\n</file>`;

/**
 * User content for one operation. Inputs come first and the task comes last, as the
 * prompting guide recommends for long contexts.
 *
 * @param {object} op
 * @param {string} op.method       HTTP method, upper case
 * @param {string} op.openapiPath  e.g. /users/{id}
 * @param {string} op.expressPath  e.g. /users/:id
 * @param {string} op.handlerFile  repo-relative path of the router file
 * @param {string} op.handlerSource the route registration call, verbatim
 * @param {string[]} op.modules    repo-relative paths of src/ files the handler depends on
 */
export function buildUserContent(op) {
  const modules = op.modules
    .map((path) => fence(path, readFileSync(path, 'utf8')))
    .join('\n\n');

  return `<operation>
${op.method} ${op.openapiPath}
Express route: ${op.method} ${op.expressPath}, registered in ${op.handlerFile}
</operation>

<handler>
${op.handlerSource.trimEnd()}
</handler>

<modules>
${modules}
</modules>

Based only on the code above, document the ${op.method} ${op.openapiPath} operation.`;
}

const jsonString = (what) => ({
  type: 'string',
  description: `${what}, serialised as a single JSON string.`,
});

const nullableJsonString = (what) => ({
  type: ['string', 'null'],
  description: `${what}, serialised as a single JSON string. null when there is none.`,
});

export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operationId', 'summary', 'description', 'parameters', 'requestBody', 'responses'],
  propertyOrdering: ['operationId', 'summary', 'description', 'parameters', 'requestBody', 'responses'],
  properties: {
    operationId: {
      type: 'string',
      description: 'lowerCamelCase verb followed by noun, unique within the API, for example archiveProject.',
    },
    summary: {
      type: 'string',
      description: 'Short imperative phrase, 50 characters or fewer, no trailing period.',
    },
    description: {
      type: 'string',
      description: '1 to 3 plain sentences: what the operation does, then the rules a caller can break.',
    },
    parameters: {
      type: 'array',
      description: 'Path, query and header parameters the handler reads. Empty when it reads none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'in', 'required', 'description', 'schema', 'example'],
        propertyOrdering: ['name', 'in', 'required', 'description', 'schema', 'example'],
        properties: {
          name: { type: 'string', description: 'Parameter name exactly as the code reads it.' },
          in: { type: 'string', enum: ['path', 'query', 'header'] },
          required: { type: 'boolean', description: 'Always true for path parameters.' },
          description: { type: 'string', description: 'One sentence: what the value identifies or controls.' },
          schema: jsonString('JSON Schema 2020-12 for the parameter value'),
          example: jsonString('One realistic value for the parameter, consistent with the other examples'),
        },
      },
    },
    requestBody: {
      type: ['object', 'null'],
      description: 'The JSON body the handler reads. null when the handler reads no body.',
      additionalProperties: false,
      required: ['required', 'description', 'schema', 'example'],
      propertyOrdering: ['required', 'description', 'schema', 'example'],
      properties: {
        required: { type: 'boolean' },
        description: { type: 'string', description: 'One sentence describing the body.' },
        schema: jsonString('JSON Schema 2020-12 for the request body'),
        example: jsonString('One realistic request body that is valid against the schema'),
      },
    },
    responses: {
      type: 'array',
      minItems: 1,
      description: 'Every status code a caller can receive from this operation, one entry each, success first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'description', 'evidence', 'schema', 'example'],
        propertyOrdering: ['status', 'description', 'evidence', 'schema', 'example'],
        properties: {
          status: { type: 'integer', minimum: 100, maximum: 599 },
          description: {
            type: 'string',
            description: 'One sentence, from the caller\'s point of view: when this status is returned.',
          },
          evidence: {
            type: 'string',
            description: 'The file path and the code that produces this status, quoted briefly. Used for review only.',
          },
          schema: nullableJsonString('JSON Schema 2020-12 for the response body'),
          example: nullableJsonString('One realistic response body that is valid against the schema'),
        },
      },
    },
  },
};
