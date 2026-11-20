import { Router } from 'express';
import { HttpError } from '../errors.js';
import { createUser, findUserByEmail, getUser } from '../store.js';

const ALLOWED_FIELDS = ['name', 'email', 'role', 'age'];
const ROLES = ['admin', 'member'];
const MIN_AGE = 0;
const MAX_AGE = 150;
// Deliberately simple: something@something.tld, no whitespace.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalid(message) {
  return new HttpError(400, 'invalid_input', message);
}

// Returns a clean { name, email, role, age } or throws a 400 HttpError.
function validateNewUser(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('Request body must be a JSON object');
  }

  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw invalid(`Unknown field(s): ${unknown.join(', ')}`);
  }

  if (typeof body.name !== 'string') {
    throw invalid('name is required and must be a string');
  }
  const name = body.name.trim();
  if (name.length < 1 || name.length > 100) {
    throw invalid('name must be 1-100 characters');
  }

  if (typeof body.email !== 'string') {
    throw invalid('email is required and must be a string');
  }
  const email = body.email.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw invalid('email must be a valid email address');
  }

  const role = body.role === undefined ? 'member' : body.role;
  if (!ROLES.includes(role)) {
    throw invalid(`role must be one of: ${ROLES.join(', ')}`);
  }

  // Optional. Omitted (or null) is stored as null so every user has the same fields.
  const age = body.age === undefined ? null : body.age;
  if (age !== null && (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE)) {
    throw invalid(`age must be a whole number from ${MIN_AGE} to ${MAX_AGE}`);
  }

  return { name, email, role, age };
}

export const usersRouter = Router();

usersRouter.post('/', (req, res) => {
  const input = validateNewUser(req.body);

  if (findUserByEmail(input.email)) {
    throw new HttpError(409, 'email_taken', 'A user with this email already exists');
  }

  res.status(201).json(createUser(input));
});

usersRouter.get('/:id', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) {
    throw new HttpError(404, 'not_found', 'User not found');
  }
  res.status(200).json(user);
});
