import { timingSafeEqual } from "node:crypto";
import { compare } from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GatewayConfig } from "../config.js";

/**
 * Constant-time string comparison for the username — `timingSafeEqual`
 * itself requires equal-length buffers, so a length mismatch (which would
 * otherwise short-circuit and leak a timing signal proportional to input
 * length) still runs a same-length compare against itself before
 * returning false, rather than returning immediately.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * HTTP Basic Auth against a single operator account (Phase 13) — not a
 * real user system, matching this project's own scope for the Admin
 * Dashboard ("Admin/Dashboard (leitura)" in docs/ARCHITECTURE.md's
 * component list). Fails closed (501) when either config value is unset,
 * rather than ever falling open to "no auth required" — an operator must
 * deliberately provision both before any `/admin/*` route becomes
 * reachable at all. The password itself is NEVER compared as plaintext —
 * `ADMIN_DASHBOARD_PASSWORD_HASH` is a bcrypt hash, verified with
 * bcryptjs's own constant-time `compare()`.
 */
export async function requireAdminAuth(
  config: Pick<GatewayConfig, "ADMIN_DASHBOARD_USERNAME" | "ADMIN_DASHBOARD_PASSWORD_HASH">,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!config.ADMIN_DASHBOARD_USERNAME || !config.ADMIN_DASHBOARD_PASSWORD_HASH) {
    await reply.code(501).send({ error: "admin_dashboard_not_configured" });
    return false;
  }

  const unauthorized = async () => {
    await reply.code(401).header("WWW-Authenticate", 'Basic realm="admin"').send({ error: "unauthorized" });
    return false;
  };

  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return unauthorized();
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return unauthorized();

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  const usernameOk = timingSafeStringEqual(username, config.ADMIN_DASHBOARD_USERNAME);
  // bcryptjs's `compare()` never throws on a malformed hash — it resolves
  // `false` — but this project never trusts a third-party library's
  // undocumented edge-case behavior blindly, hence the explicit catch too.
  const passwordOk = await compare(password, config.ADMIN_DASHBOARD_PASSWORD_HASH).catch(() => false);

  if (!usernameOk || !passwordOk) return unauthorized();
  return true;
}
