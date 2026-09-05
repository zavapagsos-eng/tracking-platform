import { register } from "@shopify/web-pixels-extension";
import {
  getOrCreateTrackingId,
  getOrCreateSessionId,
  refreshSessionId,
  captureAttribution,
  sendEvents,
  type CapturedAttribution,
} from "@tracking/pixel-kit";
import {
  mapCheckoutAddressInfoSubmitted,
  mapCheckoutCompleted,
  mapCheckoutContactInfoSubmitted,
  mapCheckoutShippingInfoSubmitted,
  mapCheckoutStarted,
  mapPaymentInfoSubmitted,
  type MapperContext,
} from "./lib/eventMapper.js";
import { redeemTransfer } from "./lib/transferRedeem.js";

const VALID_ENVIRONMENTS = new Set(["development", "staging", "production"]);
const REDEEM_ATTEMPTED_KEY = "_tp_transfer_redeem_attempted";

register(async (api) => {
  const { analytics, browser, init, settings, customerPrivacy } = api;

  const gatewayUrl = typeof settings.gateway_url === "string" ? settings.gateway_url : "";
  const shopId = typeof settings.shop_id === "string" ? settings.shop_id : "";
  const appProxyBasePath =
    typeof settings.app_proxy_base_path === "string" ? settings.app_proxy_base_path : "";
  const environmentSetting = typeof settings.environment === "string" ? settings.environment : "";
  const environment = VALID_ENVIRONMENTS.has(environmentSetting)
    ? (environmentSetting as MapperContext["environment"])
    : "production";

  if (!gatewayUrl || !shopId) {
    return; // misconfigured — fail silently (fail-open, spec section 50)
  }

  const [{ id: trackingId }, { id: sessionId }] = await Promise.all([
    getOrCreateTrackingId(browser.cookie),
    getOrCreateSessionId(browser.cookie),
  ]);
  await refreshSessionId(browser.cookie, sessionId);

  // Store B is a distinct domain — this captures whatever fbclid/UTMs are
  // present on ITS OWN landing (e.g. a customer who arrives directly at
  // checkout via a different ad). It is independent of, and does not
  // replace, the cross-domain link established below.
  const attribution: CapturedAttribution = await captureAttribution(
    browser.cookie,
    init.context.document.location.href,
    init.context.document.referrer,
  );

  let consent = { ...init.customerPrivacy };
  customerPrivacy.subscribe("visitorConsentCollected", (payload) => {
    consent = { ...payload.customerPrivacy };
  });

  function buildContext(): MapperContext {
    return {
      shopId,
      trackingId,
      sessionId,
      attribution,
      userAgent: init.context.navigator.userAgent,
      locale: init.context.navigator.language,
      consent,
      environment,
    };
  }

  analytics.subscribe("checkout_started", async (event) => {
    sendEvents(gatewayUrl, [mapCheckoutStarted(event, buildContext())]);

    // Attempt the cross-domain redeem exactly once per session — Shopify
    // may re-fire checkout_started (e.g. the buyer navigates back), and a
    // second attempt against an already-consumed token would just be a
    // harmless, expected "replay_detected" from the Gateway, but there's
    // no reason to call it more than once.
    if (appProxyBasePath) {
      const alreadyAttempted = await browser.sessionStorage.getItem(REDEEM_ATTEMPTED_KEY);
      if (!alreadyAttempted) {
        await browser.sessionStorage.setItem(REDEEM_ATTEMPTED_KEY, "1");
        await redeemTransfer({
          attributes: event.data.checkout.attributes,
          sessionId,
          appProxyBasePath,
        });
        // Outcome isn't branched on here: a failed/absent redeem simply
        // means this purchase stays UNATTRIBUTED for the A→B link — it
        // never blocks checkout, and the Reconciliation Engine (Phase 12)
        // is what surfaces persistent cross-domain failures, not the pixel.
      }
    }
  });

  analytics.subscribe("checkout_contact_info_submitted", (event) => {
    sendEvents(gatewayUrl, [mapCheckoutContactInfoSubmitted(event, buildContext())]);
  });

  analytics.subscribe("checkout_address_info_submitted", (event) => {
    sendEvents(gatewayUrl, [mapCheckoutAddressInfoSubmitted(event, buildContext())]);
  });

  analytics.subscribe("checkout_shipping_info_submitted", (event) => {
    sendEvents(gatewayUrl, [mapCheckoutShippingInfoSubmitted(event, buildContext())]);
  });

  analytics.subscribe("payment_info_submitted", (event) => {
    sendEvents(gatewayUrl, [mapPaymentInfoSubmitted(event, buildContext())]);
  });

  analytics.subscribe("checkout_completed", (event) => {
    sendEvents(gatewayUrl, [mapCheckoutCompleted(event, buildContext())]);
  });
});
