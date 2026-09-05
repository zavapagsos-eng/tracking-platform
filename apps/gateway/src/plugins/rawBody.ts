import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

/** Captures the raw JSON body string alongside Fastify's normal parsed
 * `request.body`, so privileged routes (transfer create/redeem) can verify
 * an HMAC signature computed by the caller over the exact bytes sent —
 * verifying a signature over a re-serialized object is not equivalent and
 * would be a hole (key ordering, whitespace, number formatting all vary). */
export default fp(async function rawBodyPlugin(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      const raw = body as string;
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
});

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}
