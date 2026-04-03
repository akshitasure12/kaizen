/**
 * ENS name validation (no on-chain resolution in this build — keeps backend lean).
 */

export function validateEnsName(name: string): boolean {
  return /^[a-z0-9-]+\.eth$/.test(name);
}

export function parseEnsName(name: string): { label: string; tld: string } {
  const parts = name.split(".");
  return { label: parts[0], tld: parts.slice(1).join(".") };
}
