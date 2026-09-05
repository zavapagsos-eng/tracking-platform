import type { Attribute } from "@shopify/web-pixels-extension";

export const TRANSFER_TOKEN_ATTRIBUTE_KEY = "ttid";

/** Finds the transfer token among cart/checkout attributes. Returns
 * undefined when absent — never invents a token (spec's "não inventar"
 * rule). `Checkout.attributes` is documented as unconditionally available
 * (unlike `Cart.attributes`, which requires Checkout Extensibility — see
 * docs/PHASE_LOG.md Phase 4/6), so callers should prefer reading it from
 * the checkout event data once available. */
export function findTransferToken(attributes: Attribute[] | undefined | null): string | undefined {
  return attributes?.find((attr) => attr.key === TRANSFER_TOKEN_ATTRIBUTE_KEY)?.value || undefined;
}

export type RedeemOutcome =
  | { status: "redeemed"; trackingId: string; sourceSessionId: string }
  | { status: "no_token" }
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "replay_detected" }
  | { status: "error" };

/**
 * Redeems the transfer through the App-Proxy-authenticated Gateway route
 * (never a client-embedded secret — see routes/proxy.ts on the Gateway,
 * and docs/PHASE_LOG.md Phase 4 for why). Fire-and-forget from the
 * storefront's point of view: any failure here means the purchase simply
 * stays UNATTRIBUTED for the A→B link specifically — it never blocks
 * checkout (spec section 50).
 */
export async function redeemTransfer(options: {
  attributes: Attribute[] | undefined | null;
  sessionId: string;
  appProxyBasePath: string;
  fetchImpl?: typeof fetch;
}): Promise<RedeemOutcome> {
  const token = findTransferToken(options.attributes);
  if (!token) {
    return { status: "no_token" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${options.appProxyBasePath.replace(/\/$/, "")}/transfer/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, session_id: options.sessionId }),
    });

    if (response.status === 404) return { status: "not_found" };
    if (response.status === 410) return { status: "expired" };
    if (response.status === 409) return { status: "replay_detected" };
    if (!response.ok) return { status: "error" };

    const body = (await response.json()) as { tracking_id?: string; source_session_id?: string };
    if (!body.tracking_id || !body.source_session_id) {
      return { status: "error" };
    }
    return {
      status: "redeemed",
      trackingId: body.tracking_id,
      sourceSessionId: body.source_session_id,
    };
  } catch {
    return { status: "error" };
  }
}
