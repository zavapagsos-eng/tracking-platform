import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyHmac } from "./crypto.js";

const SIGNATURE_HEADER = "x-gateway-signature";

/**
 * Verifies `X-Gateway-Signature: HMAC-SHA256(secret, rawBody)` on
 * privileged endpoints (transfer create/redeem). This is an interim
 * shared-secret scheme for our own theme/app-proxy code to authenticate to
 * the Gateway; it is intentionally replaced by Shopify App Proxy request
 * signature verification once the Store A/B app extensions are wired up in
 * Phase 4/6 (see docs/PHASE_LOG.md).
 */
export async function requireValidSignature(
  request: FastifyRequest,
  reply: FastifyReply,
  secret: string,
): Promise<boolean> {
  const signature = request.headers[SIGNATURE_HEADER];
  if (typeof signature !== "string" || signature.length === 0) {
    await reply.code(401).send({ error: "missing_signature" });
    return false;
  }

  const rawBody = request.rawBody ?? "";
  if (!verifyHmac(secret, rawBody, signature)) {
    await reply.code(401).send({ error: "invalid_signature" });
    return false;
  }

  return true;
}
