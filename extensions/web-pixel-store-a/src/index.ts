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
  mapCartViewed,
  mapPageViewed,
  mapProductAddedToCart,
  mapProductViewed,
  type MapperContext,
} from "./lib/eventMapper.js";

const VALID_ENVIRONMENTS = new Set(["development", "staging", "production"]);

register(async (api) => {
  const { analytics, browser, init, settings, customerPrivacy } = api;

  const gatewayUrl = typeof settings.gateway_url === "string" ? settings.gateway_url : "";
  const shopId = typeof settings.shop_id === "string" ? settings.shop_id : "";
  const environmentSetting = typeof settings.environment === "string" ? settings.environment : "";
  const environment = VALID_ENVIRONMENTS.has(environmentSetting)
    ? (environmentSetting as MapperContext["environment"])
    : "production";

  if (!gatewayUrl || !shopId) {
    // Misconfigured extension settings — fail silently rather than throw
    // inside the sandboxed pixel context (fail-open, spec section 50).
    return;
  }

  const [{ id: trackingId }, { id: sessionId }] = await Promise.all([
    getOrCreateTrackingId(browser.cookie),
    getOrCreateSessionId(browser.cookie),
  ]);
  // Slide the session's inactivity window on every page load.
  await refreshSessionId(browser.cookie, sessionId);

  const attribution: CapturedAttribution = await captureAttribution(
    browser.cookie,
    init.context.document.location.href,
    init.context.document.referrer,
  );

  // Start from the consent snapshot Shopify resolved before this pixel was
  // even allowed to run, then keep it current as the customer's choice
  // changes mid-session (e.g. they open a cookie banner after landing).
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

  analytics.subscribe("page_viewed", (event) => {
    sendEvents(gatewayUrl, [mapPageViewed(event, buildContext())]);
  });

  analytics.subscribe("product_viewed", (event) => {
    sendEvents(gatewayUrl, [mapProductViewed(event, buildContext())]);
  });

  analytics.subscribe("product_added_to_cart", (event) => {
    sendEvents(gatewayUrl, [mapProductAddedToCart(event, buildContext())]);
  });

  analytics.subscribe("cart_viewed", (event) => {
    sendEvents(gatewayUrl, [mapCartViewed(event, buildContext())]);
  });
});
