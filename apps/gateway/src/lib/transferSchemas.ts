import { z } from "zod";

const cartLineSchema = z.object({
  variant_id: z.string().min(1),
  quantity: z.number().int().positive(),
});

export const createTransferBodySchema = z.object({
  tracking_id: z.string().uuid(),
  session_id: z.string().uuid(),
  /** Which destination (checkout) store this specific click/product should
   * land on — the Hub theme reads this from data already on the product in
   * Shopify (a tag/metafield/collection; that mapping lives on the
   * merchant's theme, not this Gateway) and passes it through here. Must
   * match a `shop_id` in the Gateway's `SHOPIFY_STORES` registry (config.ts)
   * or `GET /r/:token` will fail closed rather than guess a domain. */
  destination_shop_id: z.string().min(1),
  cart: z.array(cartLineSchema).max(250).optional(),
});

export const redeemTransferBodySchema = z.object({
  token: z.string().min(1),
  session_id: z.string().uuid(),
});
