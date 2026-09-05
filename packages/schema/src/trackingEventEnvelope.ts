import { z } from "zod";
import { trackingEventV1Schema, type TrackingEventV1 } from "./trackingEventV1.js";

/**
 * Version dispatch for the TrackingEvent envelope.
 *
 * When a TrackingEventV2 is introduced, add it to this map keyed by its
 * `schema_version` literal. Old events already persisted (and any producer
 * still emitting schema_version "1.0") keep validating against V1 forever —
 * this is what "versionar o schema para futuras mudanças sem quebrar
 * eventos antigos" (spec section 3) means in practice.
 */
const SCHEMA_REGISTRY = {
  "1.0": trackingEventV1Schema,
} as const;

export type TrackingEvent = TrackingEventV1; // widen to a union once V2 exists

export type ParseResult =
  | { ok: true; event: TrackingEvent }
  | { ok: false; errors: z.ZodIssue[] };

/** Validates an arbitrary payload against the schema matching its declared
 * `schema_version`. Unknown/missing versions are rejected explicitly rather
 * than guessed. */
export function parseTrackingEvent(payload: unknown): ParseResult {
  const versionProbe = z
    .object({ schema_version: z.string() })
    .safeParse(payload);

  if (!versionProbe.success) {
    return { ok: false, errors: versionProbe.error.issues };
  }

  const schema =
    SCHEMA_REGISTRY[versionProbe.data.schema_version as keyof typeof SCHEMA_REGISTRY];

  if (!schema) {
    return {
      ok: false,
      errors: [
        {
          code: z.ZodIssueCode.custom,
          message: `Unsupported schema_version "${versionProbe.data.schema_version}"`,
          path: ["schema_version"],
        } as z.ZodIssue,
      ],
    };
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, errors: result.error.issues };
  }
  return { ok: true, event: result.data };
}
