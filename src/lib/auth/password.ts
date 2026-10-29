import "server-only";
import bcrypt from "bcryptjs";

export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "That password is too long.";
  if (!/[A-Za-z]/.test(password) || !/[0-9\W_]/.test(password)) {
    return "Mix letters with numbers or symbols.";
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
