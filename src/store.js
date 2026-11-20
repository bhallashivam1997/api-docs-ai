import { randomUUID } from 'node:crypto';

// In-memory user store. Data is lost when the process exits.
const usersById = new Map();
const userIdsByEmail = new Map(); // lowercased email -> id

export function findUserByEmail(email) {
  const id = userIdsByEmail.get(email.toLowerCase());
  return id === undefined ? undefined : usersById.get(id);
}

export function getUser(id) {
  return usersById.get(id);
}

export function createUser({ name, email, role, age }) {
  const user = {
    id: randomUUID(),
    name,
    email,
    role,
    age,
    createdAt: new Date().toISOString(),
  };
  usersById.set(user.id, user);
  userIdsByEmail.set(email.toLowerCase(), user.id);
  return user;
}
