import { z } from 'zod';
import { validateEnsName } from '../services/ens';

const MAX_ROLE_LENGTH = 100;
const MAX_CAPABILITIES = 50;
const MAX_CAPABILITY_LENGTH = 64;

function dedupeCapabilities(capabilities: string[]): string[] {
  const normalized = capabilities.map((value) => value.trim()).filter(Boolean);
  return Array.from(new Set(normalized));
}

const baseAgentBodySchema = z
  .object({
    ens_name: z
      .string({ required_error: 'ens_name is required' })
      .trim()
      .toLowerCase()
      .refine((value) => validateEnsName(value), {
        message: 'ens_name must match pattern label.eth using lowercase letters, numbers, or hyphens',
      }),
    role: z
      .string()
      .trim()
      .min(1, 'role must not be empty')
      .max(MAX_ROLE_LENGTH, `role must be ${MAX_ROLE_LENGTH} characters or fewer`)
      .optional(),
    capabilities: z
      .array(
        z
          .string()
          .trim()
          .min(1, 'capabilities cannot include empty values')
          .max(
            MAX_CAPABILITY_LENGTH,
            `capabilities entries must be ${MAX_CAPABILITY_LENGTH} characters or fewer`,
          ),
      )
      .max(MAX_CAPABILITIES, `capabilities must contain at most ${MAX_CAPABILITIES} items`)
      .optional()
      .default([]),
  })
  .strict();

export const createAgentBodySchema = baseAgentBodySchema
  .transform((body) => ({
    ens_name: body.ens_name,
    role: body.role,
    capabilities: dedupeCapabilities(body.capabilities),
  }));

const txHashPattern = /^0x[a-fA-F0-9]{64}$/;

export const blockchainRegisterAgentBodySchema = baseAgentBodySchema
  .extend({
    deposit_tx_hash: z
      .preprocess(
        (value) => {
          if (value === null || value === undefined) return undefined;
          if (typeof value !== 'string') return value;
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        },
        z
          .string()
          .regex(txHashPattern, 'deposit_tx_hash must be a 0x-prefixed 32-byte hex hash')
          .optional(),
      )
      .optional(),
  })
  .strict()
  .transform((body) => ({
    ens_name: body.ens_name,
    role: body.role,
    capabilities: dedupeCapabilities(body.capabilities),
    deposit_tx_hash: body.deposit_tx_hash,
  }));

export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body';
  return issue.message;
}
