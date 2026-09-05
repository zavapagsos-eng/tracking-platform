import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@tracking/db";
import { generateNonce, generateOpaqueToken, hashToken } from "./crypto.js";

export interface CreateTransferParams {
  trackingId: string;
  sessionId: string;
  /** Which destination store this transfer targets — persisted so
   * `GET /r/:token` can resolve the right domain per-transfer instead of a
   * single Gateway-wide destination (see schema.ts's comment on
   * `transfers.destinationShopId` for the full rationale). */
  destinationShopId: string;
  ttlSeconds: number;
  cartSnapshot?: unknown;
}

export interface CreateTransferResult {
  token: string;
  transferId: string;
  expiresAt: Date;
}

/** Step 1 of the cross-domain bridge (docs/ARCHITECTURE.md section C):
 * mint a single-use opaque token for the Store A -> Store B handoff. Only
 * the SHA-256 hash of the token is persisted — the raw token is returned
 * once to the caller and never stored. */
export async function createTransfer(
  db: Database,
  params: CreateTransferParams,
): Promise<CreateTransferResult> {
  const token = generateOpaqueToken();
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

  const [row] = await db
    .insert(schema.transfers)
    .values({
      tokenHash: hashToken(token),
      sourceTrackingId: params.trackingId,
      sourceSessionId: params.sessionId,
      destinationShopId: params.destinationShopId,
      nonce,
      cartSnapshot: params.cartSnapshot ?? null,
      expiresAt,
    })
    .returning({ transferId: schema.transfers.transferId });

  if (!row) {
    throw new Error("Failed to persist transfer");
  }

  return { token, transferId: row.transferId, expiresAt };
}

/** Marks the exact server-observed moment the visitor was redirected from
 * Store A towards Store B via the `/r/:token` first-party hop (spec
 * section 10). This is independent of — and happens before — redemption. */
export interface CartLine {
  variant_id: string;
  quantity: number;
}

export type RecordRedirectResult =
  | { status: "ok"; cartSnapshot: CartLine[] | null; destinationShopId: string }
  | { status: "not_found" }
  | { status: "expired" };

export async function recordTransferRedirect(
  db: Database,
  token: string,
): Promise<RecordRedirectResult> {
  const tokenHash = hashToken(token);
  const [transfer] = await db
    .select()
    .from(schema.transfers)
    .where(eq(schema.transfers.tokenHash, tokenHash))
    .limit(1);

  if (!transfer) {
    return { status: "not_found" };
  }
  if (transfer.expiresAt.getTime() < Date.now()) {
    return { status: "expired" };
  }
  return {
    status: "ok",
    cartSnapshot: (transfer.cartSnapshot as CartLine[] | null) ?? null,
    destinationShopId: transfer.destinationShopId,
  };
}

export type RedeemTransferResult =
  | { status: "redeemed"; trackingId: string; sourceSessionId: string }
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "replay_detected" };

/** Step 2 of the cross-domain bridge: Store B's Web Pixel calls this once
 * it has read the transfer token from the cart attribute it landed with.
 * On success, a DETERMINISTIC edge is created in the Identity Graph
 * linking Store A's session to Store B's session — never a probabilistic
 * guess. The DB update is guarded so two concurrent redeem attempts for
 * the same token can never both succeed (single-use is enforced
 * atomically, not just checked-then-set). */
export async function redeemTransfer(
  db: Database,
  params: { token: string; redeemedSessionId: string },
): Promise<RedeemTransferResult> {
  const tokenHash = hashToken(params.token);

  return db.transaction(async (tx) => {
    const [transfer] = await tx
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.tokenHash, tokenHash))
      .limit(1);

    if (!transfer) {
      return { status: "not_found" as const };
    }

    if (transfer.status !== "pending") {
      await tx.insert(schema.auditLogs).values({
        actor: "gateway",
        action: "transfer_replay_detected",
        entity: "transfer",
        entityId: transfer.transferId,
      });
      return { status: "replay_detected" as const };
    }

    if (transfer.expiresAt.getTime() < Date.now()) {
      await tx
        .update(schema.transfers)
        .set({ status: "expired" })
        .where(eq(schema.transfers.transferId, transfer.transferId));
      return { status: "expired" as const };
    }

    // Atomic single-use guard: only succeeds if the row is still "pending"
    // at the moment of the UPDATE, closing the check-then-act race window.
    const updated = await tx
      .update(schema.transfers)
      .set({
        status: "redeemed",
        usedAt: new Date(),
        redeemedSessionId: params.redeemedSessionId,
      })
      .where(
        and(eq(schema.transfers.transferId, transfer.transferId), eq(schema.transfers.status, "pending")),
      )
      .returning({ transferId: schema.transfers.transferId });

    if (updated.length === 0) {
      // Lost a race against a concurrent redeem of the same token.
      await tx.insert(schema.auditLogs).values({
        actor: "gateway",
        action: "transfer_replay_detected",
        entity: "transfer",
        entityId: transfer.transferId,
      });
      return { status: "replay_detected" as const };
    }

    await tx
      .insert(schema.identityLinks)
      .values({
        entityAType: "session_id",
        entityAValue: transfer.sourceSessionId,
        entityBType: "session_id",
        entityBValue: params.redeemedSessionId,
        confidence: "DETERMINISTIC",
        source: "cross_domain_transfer",
      })
      .onConflictDoNothing();

    return {
      status: "redeemed" as const,
      trackingId: transfer.sourceTrackingId,
      sourceSessionId: transfer.sourceSessionId,
    };
  });
}
