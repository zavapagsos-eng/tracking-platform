# Tracking Platform — Arquitetura (Fase 0/1)

Meta Ads + Shopify Store A (storefront) + Shopify Store B (checkout) + Shopify Payments

Status: documento de arquitetura antes de qualquer implementação de código de negócio (conforme solicitado). Repositório: `tracking-platform/`.

---

## A. Architecture Diagram

```
                                   META ADS
                                      │  (campaign → adset → ad)
                                      ▼
                                   AD CLICK  (fbclid)
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │   SHOPIFY STORE A        │
                        │   (storefront/vitrine)   │
                        │                           │
                        │  Web Pixel A (App Pixel)  │
                        │  - page_viewed            │
                        │  - product_viewed         │
                        │  - product_added_to_cart  │
                        │  - cart_viewed            │
                        └────────────┬──────────────┘
                                     │ async, keepalive/sendBeacon
                                     ▼
                        ┌─────────────────────────────────────┐
                        │         TRACKING GATEWAY (API)       │
                        │  Node.js/TypeScript · Fastify/Express│
                        │  - schema validation (Zod)           │
                        │  - identity resolution                │
                        │  - transfer create/redeem              │
                        │  - event registry (dedup)              │
                        └───────┬───────────────────┬───────────┘
                                │                     │
                                ▼                     ▼
                        ┌───────────────┐     ┌───────────────┐
                        │  PostgreSQL   │     │  Redis/BullMQ │
                        │  (system of   │     │  (queue)      │
                        │   record)     │     └───────┬───────┘
                        └───────┬───────┘             │
                                │                      ▼
                                │              ┌───────────────┐
                                │              │  Workers      │
                                │              │  - Meta CAPI  │
                                │              │  - reconcile  │
                                │              └───────┬───────┘
                                │                      ▼
                                │              ┌───────────────┐
                                │              │  Meta CAPI    │
                                │              │  (Graph API)  │
                                │              └───────────────┘
                                ▼
                        ┌─────────────────────────┐
                        │   IDENTITY GRAPH          │
                        │   (materialized in PG)    │
                        └────────────┬──────────────┘
                                     ▲
                     TRANSFER TOKEN  │  (opaque, single-use, HMAC-signed)
                     via /r/:token   │  redirect + cart attribute
                                     │
                        ┌────────────┴──────────────┐
                        │   SHOPIFY STORE B          │
                        │   (checkout/pagamento)      │
                        │                              │
                        │  Web Pixel B (App Pixel)     │
                        │  - checkout_started           │
                        │  - checkout_contact_info_*    │
                        │  - checkout_address_info_*    │
                        │  - checkout_shipping_info_*    │
                        │  - payment_info_submitted      │
                        │  - checkout_completed            │
                        └────────────┬────────────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │    SHOPIFY PAYMENTS       │
                        └────────────┬──────────────┘
                                     │
                                     ▼
                    ┌───────────────────────────────────┐
                    │   SHOPIFY ADMIN WEBHOOKS (Store B)  │
                    │   orders/create, orders/paid,        │
                    │   orders/updated, orders/cancelled,   │
                    │   refunds/create                       │
                    │   (HMAC-verified, Admin API)             │
                    └───────────────────┬───────────────────┘
                                         ▼
                                TRACKING GATEWAY
                                (webhook ingestion,
                                 idempotent by order_id)
```

Componentes lógicos: **Ingestion API** (recebe eventos de browser/pixel), **Webhook API** (recebe eventos server-to-server do Shopify), **Identity/Attribution Engine**, **Queue + Workers** (entrega assíncrona ao Meta CAPI), **Reconciliation Engine** (job periódico), **Admin/Dashboard** (leitura).

---

## B. Complete Data Flow

1. **Click**: usuário clica em anúncio Meta → chega em Store A com `fbclid` (e possivelmente UTMs) na URL.
2. **Landing (Store A)**: tema/Web Pixel A gera/recupera `tracking_id` (cookie first-party de Store A,域-scoped) e `session_id`; captura `fbclid`, lê cookies `_fbc`/`_fbp` do Pixel do Meta (se presentes), UTMs, landing URL, referrer. Envia `page_viewed` ao Gateway. Gateway grava um **attribution touch**.
3. **Navegação**: `product_viewed` (ViewContent), `product_added_to_cart` (AddToCart) são emitidos pelo Web Pixel A e enviados ao Gateway com `tracking_id`/`session_id`. Client-side, o Meta Pixel também dispara os mesmos eventos com o mesmo `event_id` (dual signal).
4. **Handoff Hub→destino**: ao clicar em "Finalizar compra"/"Buy Now", o tema chama o Gateway (`POST /transfer/create`) informando também `destination_shop_id` — qual das (potencialmente várias) lojas de destino esse produto específico deve usar, lido de dado já existente no produto no Shopify (tag/metafield/coleção; ver seção C). O Gateway gera um **transfer token** opaco, single-use, TTL curto, vinculado a `tracking_id`/`session_id`/`destination_shop_id`/snapshot do carrinho. O link para a loja de destino é montado como um **cart permalink** contendo o token como **cart attribute** (`attributes[ttid]=...`), nunca PII. Esse link passa por um endpoint first-party (`/r/:token`) hospedado no domínio do Gateway, que resolve o domínio correto *daquele transfer específico* (nunca um domínio fixo único), registra o handoff *server-side* com timestamp exato e então faz um 302 para a loja de destino correta.
5. **Redeem (Store B)**: ao carregar o carrinho/checkout de Store B, o Web Pixel B lê o cart attribute (via `init.data.cart.attributes`, a confirmar empiricamente na Fase 6) e chama `POST /transfer/redeem`. O Gateway valida assinatura HMAC, TTL, nonce e uso único; se válido, cria uma **identity link DETERMINISTIC** entre a sessão de A e a nova sessão de B (mesmo `tracking_id` lógico, ou edge `session_A ↔ session_B`).
6. **Checkout (Store B)**: Web Pixel B emite `checkout_started`, `checkout_contact_info_submitted`, `checkout_address_info_submitted`, `checkout_shipping_info_submitted`, `payment_info_submitted` — cada um mapeado para InitiateCheckout/AddPaymentInfo quando aplicável, com `event_id` compartilhado entre Pixel do navegador e o envio server-side correspondente.
7. **Pagamento**: Shopify Payments processa; Shopify gera o **order**. O Gateway NÃO confia no browser para Purchase.
8. **Webhook**: `orders/paid` (ou `orders/create` + verificação de `financial_status`, a confirmar na Fase 2 qual combinação é a mais robusta) chega ao Gateway via HTTPS, HMAC verificado. Idempotência por `order_id`.
9. **Reconciliação de atribuição**: Gateway localiza `checkout_token`/`cart_token` do pedido → sessão B → transfer → sessão A → attribution touches → calcula first/last/last-non-direct/last-paid touch → monta `user_data` normalizado (o que estiver legitimamente disponível) → gera evento canônico `Purchase` com `event_id` determinístico (derivado de `order_id`).
10. **Fila**: evento é persistido e enfileirado (BullMQ/Redis). Worker consome, chama Meta CAPI, registra resposta.
11. **Dedup no Meta**: se o Pixel de Store B também disparou `Purchase` (na order status page, quando disponível) com o mesmo `event_id`, o Meta deduplica.
12. **Reconciliação periódica**: job compara pedidos pagos no Shopify vs. Purchases no Gateway vs. entregas confirmadas no Meta, gerando alertas de divergência.

---

## C. Hub → Múltiplas Lojas de Destino — Identity Strategy

**Topologia real do merchant (confirmada diretamente com o usuário, substituindo o design original de duas lojas fixas "Store A"/"Store B" — ver docs/PHASE_LOG.md's "Correção de Arquitetura — Multi-Loja de Destino"):** existe UMA loja Hub (vitrine, catálogo de produtos) e DIVERSAS lojas de destino/checkout (2 a 10, cada uma sua própria loja Shopify, seu próprio domínio, sua própria conta Shopify Payments). Cada produto do Hub aponta para exatamente uma loja de destino — mas produtos diferentes, na mesma página do Hub, podem apontar para lojas de destino diferentes. Essa seleção "este produto → aquela loja de destino" já existe nos dados do próprio Shopify (tag, metafield ou coleção que o merchant já usa) — o Gateway/tema apenas lê e encaminha esse dado, nunca infere ou fabrica.

Problema central: Hub e cada loja de destino são domínios/lojas Shopify distintos, sem cookies compartilhados nem sessão comum nativa — e esse problema se repete N vezes (uma vez por loja de destino), não apenas uma.

**Registro de lojas (`SHOPIFY_STORES`, `apps/gateway/src/config.ts`):** um array JSON configurável por ambiente, uma entrada por loja (Hub `role: "storefront"` + cada destino `role: "checkout"`), cada uma com `shop_id`, `domain` e seu próprio `webhook_secret`. Escolhido em vez de uma tabela dinâmica no banco porque o número de lojas é pequeno e estável (confirmado com o usuário: 2–10, trocado raramente) — adicionar/remover uma loja de destino é uma mudança de configuração, não de código. `findStoreByShopId()` é o único ponto de resolução `shop_id → domínio/segredo`; toda rota que depende de uma loja específica (`GET /r/:token`, `/webhooks/:store/*`) falha fechado (404/500) para um `shop_id` não registrado, nunca adivinha um destino.

**`SHOPIFY_APP_PROXY_SECRET` permanece um único valor compartilhado** (não um segredo por loja) — verificado diretamente na documentação oficial do Shopify (shopify.dev, "Authenticate app proxies"): a assinatura de uma requisição de App Proxy usa o client secret OAuth do app instalado, o mesmo valor não importa de qual loja veio a requisição. Diferente de `webhook_secret`, que é por loja (cada loja Shopify que instala o app recebe suas próprias inscrições de webhook e seu próprio segredo).

**Estratégia adotada — Transfer Token opaco (server-mediated), agora com destino por-transfer:**

- Estrutura do token: valor aleatório de 256 bits (via `crypto.randomBytes`) usado como chave de lookup server-side (**não** um JWT autocontido, para permitir revogação/uso único garantido no banco); adicionalmente assinado com HMAC-SHA256 (segredo do Gateway) para detectar adulteração caso o token trafegue por parâmetro de URL.
- Conteúdo armazenado no Gateway (nunca no token em si): `transfer_id`, `tracking_id`, `session_id` de origem, **`destination_shop_id`** (qual loja de destino este transfer específico deve resolver — persistido por linha, nunca assumido como um único domínio fixo do Gateway inteiro), `cart_snapshot_ref`, `nonce`, `created_at`, `expires_at` (recomendado 5–15 min), `used_at` (null até redeem), `redeemed_by_session_id`.
- Transporte: cart permalink attribute da loja de destino correta (`attributes[ttid]`), nunca em campos visíveis ao cliente como nome/e-mail/telefone. Nenhuma PII trafega na URL.
- Consumo: single-use — primeira leitura válida marca `used_at`; qualquer tentativa subsequente é rejeitada e gera alerta `CROSS_DOMAIN_REPLAY_DETECTED`.
- Proteção contra replay: nonce + timestamp + verificação de IP/UA apenas como sinal auxiliar de anomalia (nunca como chave de identidade, conforme regra de ouro do projeto).
- Redirect server-assisted (`/r/:token`, seção 10 do spec): resolve `destination_shop_id` do transfer via `findStoreByShopId()` e monta o cart permalink com O DOMÍNIO DAQUELA loja de destino especificamente — nunca um domínio único fixo para todo o Gateway. Permite registrar o instante exato da saída do Hub independente de JS do navegador, e reduz a superfície de manipulação client-side do token. Se `destination_shop_id` não estiver mais registrado em `SHOPIFY_STORES` (loja removida/erro de configuração), a rota falha fechado com 500 em vez de redirecionar para um destino adivinhado.
- Resultado da resolução: `tracking_id` da loja de destino é vinculado a `tracking_id` do Hub com nível **DETERMINISTIC** no Identity Graph, independente de qual das N lojas de destino foi o alvo. Se o redeem falhar (token expirado, ausente, adulterado), a sessão de destino nasce como visitante novo e a compra correspondente é marcada `UNATTRIBUTED_CROSS_DOMAIN` — nunca inventamos o vínculo.

**Web Pixel por loja de destino**: cada loja de destino instala sua própria cópia da extensão Web Pixel, com seu próprio `shop_id` configurado em `settings` (`shopify.extension.toml`) — o código do pixel é idêntico entre lojas de destino, apenas a configuração de instalação muda. Isso significa que suportar uma N-ésima loja de destino não exige nenhuma mudança de código no pixel, apenas uma nova instalação + uma nova entrada em `SHOPIFY_STORES`.

**Limitação conhecida a validar na Fase 6**: a superfície exata de dados acessíveis via `init` no Web Pixel de uma loja de destino (se `cart.attributes` está de fato exposto a Custom/App Pixels) precisa ser confirmada empiricamente em loja de desenvolvimento, pois a documentação pública é pouco explícita sobre isso. Caminho alternativo, caso não esteja disponível: recuperar o token via Checkout UI Extension (que tem acesso a `attributes`/`note` do checkout) enviando-o ao Gateway por `fetch` autenticado.

---

## D. Meta Attribution Strategy

- **Touch table imutável**: todo touch publicitário relevante (clique com `fbclid`, ou sessão com `fbc`/`fbp` presentes) é gravado como linha independente em `attribution_touches`, nunca sobrescrita.
- **`gclid` (Google Ads) capturado desde já, sem uso de envio ainda**: a mesma captura de URL que lê `fbclid` também lê `gclid` (o click id que o Google Ads anexa à URL de destino) e persiste em `attribution_touches.gclid`, classificando o touch como pago (`source: "google"`, `medium: "cpc"`, salvo UTM explícito) pela mesma regra do `fbclid` — presença do click id, nunca um `utm_source` isolado. Isso é feito propositalmente ANTES de existir qualquer campanha ativa no Google Ads (hoje só há Meta Ads): um clique não capturado agora nunca mais existirá quando essa integração for construída. Nada é enviado a nenhuma API do Google ainda — isso é só captura/armazenamento, o "envio" (Google Ads Enhanced Conversions ou GA4 Measurement Protocol, que são integrações distintas) é trabalho futuro, não coberto por nenhuma fase até aqui.
- **Modelos calculados em paralelo** (não apenas um "vencedor"): FIRST_TOUCH, LAST_TOUCH, LAST_NON_DIRECT, LAST_PAID_TOUCH. Todos ficam disponíveis por compra; o dashboard permite alternar o modelo de visualização.
- **Sinal usado para o envio ao Meta CAPI**: `fbc`/`fbp` mais recentes disponíveis na jornada (que é o que o próprio Meta usa para seu matching interno), acompanhados de `event_id` para dedup — a "atribuição" reportada nos modelos acima é analítica/interna, não altera o que é enviado como `user_data` ao Meta.
- **Event Match Quality (EMQ)**: maximizada enviando todos os campos de `user_data` legitimamente disponíveis em cada estágio, nunca inferidos. Implementado na Fase 10 (`lib/metaNormalization.ts`, `lib/metaCapiPurchase.ts`) para `em`/`ph` (hash de email/telefone do Order webhook), `fbc`/`fbp` (mais recentes da jornada), `client_ip_address`/`client_user_agent`, e `external_id` (`tracking_id`). Escopo explicitamente não coberto ainda: `fn`/`ln`/`ct`/`st`/`zp`/`country` — Shopify's Order webhook carrega esses dados, mas persisti-los com segurança depende da criptografia em repouso desenhada para `identity_private.first_name_enc`/`last_name_enc`/`address_enc` (ver seção I), uma decisão de infraestrutura de segurança adiada para a Fase 15. Ver `docs/PHASE_LOG.md` Fase 10 para o detalhamento.
- **Sequência preservada**: exemplo do spec (Meta A dia 1 → Direto dia 3 → Meta B dia 5 → Purchase dia 5) fica totalmente reconstruível a partir de `attribution_touches`, permitindo recalcular qualquer modelo retroativamente sem perda de dado histórico.

---

## E. Identity Graph Design

Grafo de identidade materializado em Postgres (tabela `identity_links`) como arestas tipadas entre entidades, não um único "super ID" fusível.

**Entidades (nós):**
`tracking_id`, `session_id`, `shopify_customer_id` (quando disponível), `checkout_token`/`order_id`, `email_hash`, `phone_hash`, `external_id`, `fbp`, `fbc`.

**Arestas e nível de confiança:**

| Vínculo | Nível | Origem |
|---|---|---|
| `tracking_id` ↔ `session_id` | DETERMINISTIC | cookie first-party próprio |
| `session_id_A` ↔ `session_id_B` | DETERMINISTIC | transfer token validado |
| `session_id` ↔ `checkout_token`/`order_id` | DETERMINISTIC | Web Pixel B + webhook |
| `order_id` ↔ `email_hash`/`phone_hash` | DETERMINISTIC | dados do pedido (Shopify) |
| `fbc`/`fbp` ↔ `session_id` | DETERMINISTIC | cookie do Pixel lido no client |
| IP/User-Agent ↔ qualquer entidade | **nunca usado como chave**, apenas atributo auxiliar/anomalia | — |

- Consultas de reconstrução de jornada (Journey Inspector) percorrem o grafo a partir de `order_id` até `attribution_touches`.
- Enum explícito `link_confidence`: `DETERMINISTIC | PROBABILISTIC | UNKNOWN`. Hoje, na arquitetura definida, **nenhum vínculo PROBABILISTIC é criado automaticamente** (não fazemos matching por IP/UA/fingerprint); o nível existe no schema para eventual uso futuro controlado e auditável, sempre exibido como tal no dashboard, nunca misturado com DETERMINISTIC em métricas de cobertura.

---

## F. Event Deduplication Strategy

- **Regra fundamental**: mesmo evento lógico de negócio ⇒ mesmo `event_id`, gerado uma única vez e reutilizado tanto pelo Meta Pixel (browser) quanto pelo envio equivalente via Meta CAPI (server).
- **Geração do `event_id`**:
  - Eventos de navegação (PageView/ViewContent/AddToCart/InitiateCheckout/AddPaymentInfo): gerado client-side pelo Web Pixel no momento do evento (UUID v4), propagado ao Gateway junto ao payload; se o mesmo evento lógico também tiver uma via server (ex.: `AddToCart` confirmado por webhook de carrinho, quando existir), reutiliza o mesmo `event_id` recuperado do `event_registry`.
  - **Purchase**: `event_id` **determinístico**, derivado do `order_id` (`purchase:{shop_id}:{order_id}`), nunca aleatório — isso garante que reentregas de webhook ou reenvios de fila resultem no mesmo `event_id`, permitindo dedup tanto contra o Pixel do navegador (order status page) quanto contra retries internos.
- **`event_registry`**: antes de qualquer envio ao Meta, o Gateway verifica se aquele `event_id` já foi marcado `meta_sent`. Em caso positivo, o envio é descartado localmente (dedup interno), independente da janela de 48h do Meta.
- **Janela de dedup do Meta**: 48h entre o par Pixel/CAPI com mesmo `event_id` + mesmo `event_name`; o processamento por fila deste projeto é desenhado para entregar Purchase em minutos, muito dentro dessa janela.

---

## G. Purchase Confirmation Strategy

- **Fonte de verdade**: webhooks Admin API de Store B (`orders/create`, `orders/paid`, `orders/cancelled`, `refunds/create`), HMAC verificado antes de qualquer processamento. O browser (thank-you page / order status page) é tratado como **sinal auxiliar para dedup do Pixel**, nunca como gatilho único de Purchase.
- **Critério de "pago"**: a decisão exata entre usar `orders/paid` isoladamente vs. `orders/create` + checar `financial_status in {paid, partially_paid}` será fixada na Fase 2/7 após checar comportamento atual documentado (ambos os tópicos existem; `orders/paid` é disparado quando o pedido é totalmente pago, o que é o padrão mais direto para "Purchase"; pedidos com captura manual ou parcial exigem tratamento explícito e configurável).
- **Idempotência**: chave = `order_id` (+ `shop_id`). Reentregas do mesmo webhook (Shopify pode reentregar) não geram novo Purchase — apenas atualizam `last_received_at`/`delivery_status` em `event_registry`.
- Detalhado na seção H (state machine) e seção sobre idempotência.

---

## H. Database ER Diagram

```
visitors (tracking_id PK)
   │ 1—N
   ▼
sessions (session_id PK, tracking_id FK, shop_role[storefront|checkout], shop_id, started_at, ...)
   │ 1—N                                  │ 1—1 (nullable)
   ▼                                       ▼
attribution_touches                  transfers (transfer_id PK, source_session_id FK,
 (touch_id PK, tracking_id FK,                   redeemed_session_id FK, token_hash,
  session_id FK, source, medium,                 nonce, created_at, expires_at, used_at)
  campaign, campaign_id, adset_id,
  ad_id, fbclid, fbc, fbp,
  landing_page, referrer, ts)

sessions (checkout side) 1—1 checkouts (checkout_token PK, session_id FK, cart_token,
                                          customer_id_shopify, currency, started_at)
                                              │ 1—1 (eventual)
                                              ▼
                                          orders (order_id PK, shop_id, checkout_token FK,
                                                   financial_status, currency, presentment_currency,
                                                   total_amount, created_at, paid_at)
                                              │ 1—N                     │ 1—N
                                              ▼                         ▼
                                          payments                 refunds
                                          (payment_id, order_id FK,  (refund_id, order_id FK,
                                           status, gateway, ts)       amount, reason, ts)

events (event_id PK, event_name, tracking_id FK, session_id FK, schema_version,
        source[browser|server], payload_json, received_at)
   │ 1—1
   ▼
event_registry (event_id PK, event_name, tracking_id, session_id, source,
                 first_seen, browser_received bool, server_received bool,
                 meta_sent bool, status)

meta_deliveries (delivery_id PK, event_id FK, request_ts, http_status,
                  response_json_redacted, attempt_count, delivery_status)

identity_links (link_id PK, entity_a_type, entity_a_value, entity_b_type,
                entity_b_value, confidence[DETERMINISTIC|PROBABILISTIC|UNKNOWN],
                source, created_at)

identity_private (tracking_id FK, email_hash, phone_hash, first_name_enc,
                   last_name_enc, address_enc, encrypted_at)   -- separado de `events`

consent_states (consent_id PK, shop_id, session_id FK, analyticsProcessingAllowed,
                 marketingAllowed, preferencesProcessingAllowed, saleOfDataAllowed,
                 recorded_at)

webhook_receipts (receipt_id PK, shop_id, topic, webhook_id, hmac_valid,
                   received_at, processing_status)

reconciliation_runs (run_id PK, started_at, finished_at, matched, missing_local,
                      missing_meta, duplicated, value_mismatch, unattributed)

audit_logs (log_id PK, actor, action, entity, entity_id, ts, metadata_redacted)
```

Índices principais: `sessions(tracking_id)`, `attribution_touches(tracking_id, ts)`, `orders(checkout_token)`, `orders(order_id) UNIQUE`, `event_registry(event_id) UNIQUE`, `identity_links(entity_a_type, entity_a_value)`, `identity_links(entity_b_type, entity_b_value)`, `transfers(token_hash) UNIQUE`, `webhook_receipts(shop_id, webhook_id) UNIQUE` (idempotência de entrega).

---

## I. Privacy / Consent Architecture

- **Consentimento por loja, não global**: `consent_states` é sempre associado a `shop_id` + `session_id`. Consentimento coletado em Store A **não** é propagado automaticamente como autorização em Store B — cada loja registra seu próprio estado via Shopify Customer Privacy API / banner de consentimento (a confirmar mecanismo atual suportado por tema/CMP na Fase 6).
- Quatro flags rastreadas por evento: `analyticsProcessingAllowed`, `marketingAllowed`, `preferencesProcessingAllowed`, `saleOfDataAllowed`.
- **Regra de decisão**: cada envio ao Meta CAPI/Pixel consulta o consentimento vigente da loja de origem do evento antes de transmitir; sem consentimento de marketing, evento é registrado internamente (para diagnóstico) mas não expedido ao Meta.
- **PII protegida (Shopify)**: campos de nome/e-mail/telefone/endereço em eventos de Web Pixel só chegam preenchidos se o app tiver os scopes de *protected customer data* aprovados (`read_customer_name`, `read_customer_email`, `read_customer_phone`, `read_customer_address`, `read_customer_personal_data` — nomenclatura a confirmar exatamente no momento do cadastro do app, ver seção K); caso contrário Shopify retorna `null` nesses campos e o sistema trata isso como ausência legítima, não como erro.
- **Minimização**: `identity_private` (PII) fisicamente separada de `events`/`attribution_touches`; criptografia at-rest no Postgres (pgcrypto ou criptografia a nível de coluna na aplicação); acesso restrito por role de banco; políticas de retenção configuráveis por tabela (ex.: eventos brutos 90 dias, `identity_private` conforme política comercial/legal do lojista).
- **Direitos do titular / webhooks obrigatórios Shopify**: `customers/data_request`, `customers/redact`, `shop/redact` implementados desde o início (mandatórios para qualquer app Shopify que processa dados de cliente).

---

## J. Failure / Recovery Architecture

- **Fail-open comercial**: se o Gateway estiver indisponível, o checkout do Shopify **não é bloqueado** — o Web Pixel falha silenciosamente (fetch com timeout curto, sem exigir resposta síncrona) e a venda prossegue normalmente. O Purchase ainda será recuperado depois via webhook + reconciliação, então nenhuma venda é "perdida" do ponto de vista financeiro, apenas eventos de navegação intermediários podem faltar.
- **Fila durável (BullMQ/Redis)**: todo envio ao Meta passa pela fila; falha de rede/API do Meta não derruba o pipeline de ingestão.
- **Retry**: backoff exponencial + jitter, número máximo de tentativas configurável, Dead Letter Queue para erros permanentes (payload inválido, credencial revogada) separados de erros retryable (timeout, 5xx, rate limit do Meta).
- **Webhook idempotency**: `webhook_receipts` com chave única `(shop_id, webhook_id)` — reentregas do Shopify são reconhecidas e não reprocessadas.
- **Reconciliation Engine** (job periódico): compara `orders(financial_status=paid)` × `event_registry(event_name=Purchase, meta_sent)` × respostas do Meta, gerando categorias `MATCHED / MISSING_LOCAL / MISSING_META / DUPLICATED / VALUE_MISMATCH / CURRENCY_MISMATCH / UNATTRIBUTED` — nunca fabricando atribuição para fechar a conta.
- **Alertas automáticos** (seção 34/45 do spec): `ATTRIBUTION_LOST`, `CROSS_DOMAIN_FAILURE`, `CAPI_DELIVERY_FAILURE`, além de degradação de SLO (ingestion success, queue backlog, transfer success rate).

---

## K. APIs Oficiais Verificadas (pesquisa Fase 0)

| API / Doc | Uso no projeto | Status verificado | Fonte |
|---|---|---|---|
| Shopify **Web Pixels API** | Captura de eventos em Store A e B (App Pixels) | Ativa/GA; App Pixels via `@shopify/web-pixels-extension`, Custom Pixels via admin | [shopify.dev/docs/api/web-pixels-api](https://shopify.dev/docs/api/web-pixels-api) |
| Shopify **Protected Customer Data** — scopes obrigatórios | Acesso a nome/e-mail/telefone/endereço em eventos de pixel | Enforcement em vigor desde 10/dez (campos retornam `null` sem aprovação) | [shopify.dev/changelog/protected-customer-data-scopes-required](https://shopify.dev/changelog/protected-customer-data-scopes-required) |
| Shopify **Access Scopes / Protected Customer Data requirements** | Processo de solicitação de acesso a dados protegidos | App não tem acesso por padrão; requer aprovação | [shopify.dev/docs/api/usage/access-scopes](https://shopify.dev/docs/api/usage/access-scopes) |
| Shopify **Admin API Webhooks** (orders/create, orders/paid, orders/updated, refunds/create) | Confirmação server-to-server de pagamento/reembolso | Tópicos ativos; diferenças exatas entre `orders/paid` e `orders/updated` a validar em ambiente de teste na Fase 7 | levantamento via fóruns oficiais Shopify Dev Community |
| Shopify **Checkout Extensibility** (fim de Additional Scripts / checkout.liquid) | Define onde o Web Pixel B pode/deve capturar eventos de checkout | Migração obrigatória — Additional Scripts sendo descontinuado por cronograma da Shopify (datas variam por tipo de loja; confirmar prazo específico da loja do cliente antes da Fase 6) | pesquisa de mercado; validar prazo oficial exato no admin da loja |
| Meta **Conversions API — Customer Information Parameters** | Normalização/hashing de `em, ph, fn, ln, ct, st, zp, country`; campos não-hasheados `client_ip_address, client_user_agent, fbc, fbp` | Documentação oficial de referência para o `normalizeMetaUserData()` | developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters |
| Meta **Deduplicate Pixel and Server Events** | Base da estratégia de `event_id` compartilhado | Janela de 48h, `event_id` + `event_name` como método primário | developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events |
| Shopify GDPR **mandatory webhooks** | `customers/data_request`, `customers/redact`, `shop/redact` | Obrigatórios para apps que tratam dados de cliente | Shopify App requirements (padrão estável) |

**Nota metodológica**: os fetches automatizados às páginas oficiais do shopify.dev retornaram resumos truncados em alguns pontos (ex.: lista completa de eventos padrão do Web Pixel, nomenclatura exata dos scopes de protected data). Antes da Fase 4/6/7, cada um desses pontos será re-verificado diretamente no Partner Dashboard / documentação renderizada (não apenas o resumo automatizado) e registrado em `docs/VERIFIED_APIS.md`.

---

## L. Riscos e Limitações Identificados

1. **PII em pixel sem aprovação de scope** → campos de nome/e-mail/telefone/endereço chegam `null` até o app ser aprovado para *protected customer data*; isso reduz EMQ até a aprovação ser concedida (processo de review da Shopify, prazo fora do nosso controle).
2. **Migração Checkout Extensibility** → se a Store B ainda usa checkout.liquid/Additional Scripts, há prazo de descontinuação; o Web Pixel B (Customer Events) é o caminho suportado e deve ser adotado desde já, independentemente da migração de scripts adicionais.
3. **Cookies de terceiros/first-party entre domínios** → `_fbc`/`_fbp` do Meta Pixel são *por domínio*; ao mudar de Store A para Store B, o Pixel de B pode gerar um `_fbp` novo. A captura de `fbc`/`fbp` de A é preservada no transfer/identity graph e reaproveitada no envio server-side em B mesmo que o navegador tenha um `_fbp` diferente em B — isso é tratado explicitamente, não ignorado.
4. **ATT/Safari ITP/bloqueadores** → parte dos usuários não terá `fbp`/`fbc` client-side de forma alguma; nesses casos o matching depende mais fortemente de sinais server-side legítimos (e-mail/telefone quando fornecidos no checkout), e a ausência é registrada como tal (não contornada).
5. **Acesso a `cart.attributes` no Web Pixel de Store B** não está claramente documentado publicamente — precisa validação empírica em loja de dev antes de finalizar o design do redeem (fallback: Checkout UI Extension).
6. **Reentrega/atraso de webhooks Shopify** → exige idempotência robusta (implementada) e tolerância a atraso na state machine de Purchase.
7. **Moeda de apresentação vs. moeda do pedido** → lojas internacionais podem exibir preço em moeda local (`presentment_currency`) diferente da moeda de liquidação (`currency`); o valor exato a reportar ao Meta será o documentado como esperado pelo CAPI (a confirmar campo exato na Fase 10), nunca convertido silenciosamente por nós.
8. **Rate limits das Admin/GraphQL APIs do Shopify** e do Graph API do Meta precisam de tratamento de backoff dedicado (endereçado na seção J/Fila).
9. **Aprovação de Protected Customer Data em lojas de desenvolvimento** pode exigir processo manual não instantâneo — planejar isso no cronograma antes da Fase 6.
10. **Este documento foi produzido com pesquisa automatizada (WebSearch/WebFetch)**; para os pontos marcados "a confirmar", a verificação final será feita lendo a documentação renderizada completa (não resumos) antes de codificar a fase correspondente, conforme exigido pelo spec.

---

## M. Plano de Implementação por Fases

| Fase | Entregável | Critério de conclusão |
|---|---|---|
| 0 | Pesquisa oficial (este documento, seção K/L) | Concluída nesta entrega |
| 1 | Arquitetura + threat model + data flow (este documento) | Aprovação do usuário antes de código |
| 2 | Schema Postgres + `TrackingEventV1` (Zod) + migrations | `npm run migrate` + testes de schema passando |
| 3 | Tracking Gateway (ingestion API, identity, transfer create/redeem) | Endpoints testados localmente com Postgres+Redis |
| 4 | Web Pixel Store A | Eventos chegando no Gateway a partir de loja de dev |
| 5 | Cross-domain bridge (`/r/:token`, transfer redeem) | Teste E2E do handoff A→B |
| 6 | Web Pixel Store B (+ redeem do transfer) | Sessão B linkada a sessão A em loja de dev |
| 7 | Shopify webhooks (orders/paid, refunds, GDPR) | HMAC validado, idempotência testada |
| 8 | Identity Graph | Consultas de reconstrução de jornada funcionando |
| 9 | Attribution Engine (4 modelos) | Testes unitários dos 4 modelos |
| 10 | Meta CAPI Service + normalização | Envio de teste validado via Test Events do Meta |
| 11 | Fila + retries + DLQ | Teste de falha simulada do Meta |
| 12 | Reconciliation Engine | Job rodando contra dados de teste |
| 13 | Dashboard + Journey Inspector | Cobertura visível para um pedido de teste |
| 14 | Suite de testes automatizados (lista da seção 51/52) | `npm test` verde |
| 15 | Revisão de segurança | Checklist da seção 42/43 revisado |
| 16 | Deployment (Docker, guia de produção) | `docker compose up` local completo funcionando |

Cada fase será: implementada → lint → typecheck → testes → correção → documentação → só então a próxima fase começa, conforme exigido.

---

## N. Reconciliation Engine + Admin Dashboard (Fases 12/13, implementação concreta)

A seção J já descrevia o desenho pretendido; esta seção documenta o que foi de fato implementado.

**Limite de escopo honesto**: a Reconciliation Engine compara Postgres contra Postgres — `orders` (fonte de verdade: webhooks Shopify) × `event_registry`/`meta_deliveries` (o registro durável que o próprio Gateway mantém do que o Meta respondeu no momento do envio). Ela NÃO consulta uma API do Meta ao vivo para confirmar recebimento — essa API não existe publicamente para uma busca por `event_id` individual (Events Manager é uma UI; as APIs de Insights/match-rate só reportam métricas agregadas). "Respostas do Meta" nas categorias abaixo sempre significa esse registro local, nunca uma checagem cruzada inventada.

**Categorias** (`apps/gateway/src/lib/reconciliation.ts`):
- **MATCHED**: `event_registry.meta_sent = true`, exatamente uma linha `delivered` em `meta_deliveries`, e o snapshot `value_sent`/`currency_sent` daquela entrega bate com o `orders` atual.
- **DUPLICATED**: mais de uma linha `delivered` para o mesmo `event_id` — nunca deveria acontecer dado o gate de dedup em `sendPurchaseToMeta`, sinal de bug a investigar.
- **VALUE_MISMATCH** / **CURRENCY_MISMATCH**: o snapshot da entrega mais recente diverge do `orders` atual.
- **UNATTRIBUTED**: existe uma linha em `dead_letters` cujo `failure_reason` é um gap estrutural (`consent_not_granted`, `order_not_found`, `no_checkout_correlation`, `checkout_not_tracked`, `session_not_tracked`) — nunca sequer chegou a tentar o Meta.
- **MISSING_META**: ou (a) uma linha em `dead_letters` cujo motivo é um erro real do Meta CAPI (permanente ou tentativas esgotadas), ou (b) nenhuma tentativa registrada e o pedido foi pago há mais de `RECONCILIATION_STALE_AFTER_MINUTES` (default 15) — antes disso, é tratado como ainda legitimamente em trânsito, nunca sinalizado à toa.
- **MISSING_LOCAL**: a direção reversa — um `event_registry` com `meta_sent=true` cujo `order_id` (extraído do `event_id`) não existe (mais) em `orders`.

**Remediação automática, limitada**: `requeueEligibleOrders()` só age sobre `MISSING_META`/`UNATTRIBUTED` (nunca sobre `MATCHED`/`DUPLICATED`/`*_MISMATCH`, que precisam de decisão humana ou só piorariam com um reenvio), respeitando a restrição de reuso de `jobId` do BullMQ documentada na Fase 11 (remove o job antigo antes de reenfileirar) e limitada por `RECONCILIATION_MAX_REQUEUE_ATTEMPTS`/`RECONCILIATION_REQUEUE_COOLDOWN_MINUTES` — nunca retenta para sempre, nunca martela a cada ciclo do cron.

**Processo próprio**: `apps/gateway/src/reconciliationCron.ts` roda como processo standalone agendado por `RECONCILIATION_CRON` (via `node-cron`), nunca como efeito colateral do Gateway HTTP ou do worker do Meta CAPI — mesmo padrão do worker da Fase 11.

**Admin Dashboard (leitura)**: `apps/gateway/src/routes/admin.ts`, protegido por HTTP Basic Auth (`apps/gateway/src/lib/adminAuth.ts` — usuário único, senha comparada via bcrypt, nunca em texto puro; falha fechado com 501 se `ADMIN_DASHBOARD_USERNAME`/`ADMIN_DASHBOARD_PASSWORD_HASH` não estiverem configurados). Uma API JSON, não uma UI renderizada — suficiente para o critério de conclusão da Fase 13 ("cobertura visível para um pedido de teste") sem construir um frontend que ninguém pediu:
- `GET /admin/journey/:orderId` — Journey Inspector, expõe `reconstructJourneyByOrderId` (Fase 9) diretamente.
- `GET /admin/reconciliation/runs` — histórico de execuções da Reconciliation Engine.
- `POST /admin/reconciliation/run` — dispara um ciclo sob demanda (mesmo scan + reenfileiramento limitado do cron).
- `GET /admin/dead-letters` — problemas correntes que ainda precisam de atenção.

---

*Próximo passo: iniciar Fase 2 (schema de banco de dados + `TrackingEventV1`), seguido pela Fase 3 (Tracking Gateway).*
