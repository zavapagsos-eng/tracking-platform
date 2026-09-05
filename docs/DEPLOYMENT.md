# Deployment — Fase 16

Guia de produção para o Tracking Platform (Gateway + Worker + Reconciliation Engine). Escopo desta fase: empacotamento em containers (`apps/gateway/Dockerfile`, `docker-compose.yml`) e este documento — a infraestrutura real de produção (qual provedor de hospedagem, qual proxy reverso, qual gerenciador de segredos) não existe ainda neste ambiente, então este guia é escrito para ser válido contra qualquer orquestrador de containers razoável (Docker Compose num único host, Railway, ECS, Kubernetes, etc.), não amarrado a um provedor específico.

## 1. Pré-requisitos

- Postgres 16+ e Redis 7+ acessíveis pela rede onde os serviços abaixo vão rodar (podem ser gerenciados pelo provedor de hospedagem — RDS, Upstash, etc. — não precisam ser os containers `postgres`/`redis` deste `docker-compose.yml`, que existem para desenvolvimento local e como referência).
- Um proxy reverso real na frente do Gateway (nginx, Caddy, o load balancer do provedor de hospedagem, etc.) que termine TLS e **sobrescreva** (nunca repasse) qualquer `X-Forwarded-For` vindo do cliente — ver seção 5.
- Node 20+ apenas se você for rodar fora de container; os Dockerfiles já fixam essa versão.

## 2. Os quatro processos

Este projeto não é um único serviço — são quatro processos distintos, cada um com sua própria razão para nunca rodar como efeito colateral de outro (decisão tomada e documentada já nas Fases 3/11/12):

| Processo | Serviço no `docker-compose.yml` | Comando (imagem já compilada) | Réplicas |
|---|---|---|---|
| Gateway HTTP (ingestão, webhooks, admin API) | `gateway` | `node apps/gateway/dist/index.js` (o `CMD` padrão da imagem) | N (stateless, pode escalar horizontalmente atrás de um load balancer) |
| Worker de entrega ao Meta CAPI (Fase 11) | `worker` | `node apps/gateway/dist/worker.js` | N (BullMQ distribui jobs entre múltiplos consumers com segurança) |
| Reconciliation Engine (Fase 12) | `reconciliation` | `node apps/gateway/dist/reconciliationCron.js` | **1 (singleton) — nunca mais de uma réplica.** Cada réplica rodaria seu próprio `node-cron` de forma independente; duas réplicas produziriam duas varreduras/duas linhas em `reconciliation_runs` no mesmo ciclo e poderiam competir para reenfileirar o mesmo pedido (o cooldown em `RECONCILIATION_REQUEUE_COOLDOWN_MINUTES` mitiga duplicar o envio real, mas não o desperdício de trabalho nem o ruído nos logs) |
| Migração de schema (Fase 2+) | `migrate` (perfil `tools`, não sobe com `docker compose up`) | `npm run db:migrate:start -w @tracking/db` | Um-off, roda até terminar e sai — nunca um serviço de longa duração |

As três primeiras imagens de container são construídas a partir do **mesmo** `apps/gateway/Dockerfile` (mesmo `docker build`, resultado idêntico) — só o comando final muda. Isso é deliberado: garante que o worker e o reconciliation engine rodem exatamente o mesmo código com o qual o gateway foi construído, sem uma segunda receita de build para manter sincronizada.

## 3. Variáveis de ambiente

`.env.example` (raiz do repo) documenta cada variável, seu default e por que existe. Nenhuma delas deve ser fabricada com um placeholder em produção — as que faltarem devem simplesmente ficar de fora (o padrão fail-closed já estabelecido em todo o projeto: Meta CAPI, Admin Dashboard e as assinaturas por loja em `SHOPIFY_STORES` todos desligam a própria feature em vez de rodar com uma credencial inventada).

**Obrigatórias em qualquer ambiente**: `DATABASE_URL`, `GATEWAY_HMAC_SECRET` (32+ bytes aleatórios reais — nunca o valor de exemplo do `.env.example`).

**Obrigatórias para cada integração que você for usar**: `SHOPIFY_STORES` (registro completo de lojas, cada uma com seu próprio `webhook_secret`), `SHOPIFY_APP_PROXY_SECRET`, `META_DATASET_ID`/`META_PIXEL_ID` + `META_ACCESS_TOKEN`, `ADMIN_DASHBOARD_USERNAME` + `ADMIN_DASHBOARD_PASSWORD_HASH`, `REDIS_URL` (necessária para o worker e para o auto-requeue do reconciliation; sem ela o Gateway ainda sobe, só que sem fila/sem retry automático — ver Fase 11).

**Segredos — como injetar em produção real**: este `docker-compose.yml` usa `env_file: .env` por simplicidade local. Numa hospedagem real, prefira o cofre de segredos da própria plataforma (variáveis de ambiente gerenciadas do provedor, AWS Secrets Manager, etc.) em vez de um arquivo `.env` em disco — `.dockerignore` (adicionado nesta fase) já impede que `.env` seja copiado para dentro de uma imagem por engano, mas isso não substitui um cofre de segredos de verdade para quem for operar isso em escala.

## 4. Passo a passo

```bash
# 1. Construir as imagens (todas os três serviços de app usam a mesma receita)
docker compose build

# 2. Rodar a migração UMA VEZ, antes de subir qualquer coisa que use o banco
#    (nunca automaticamente no boot do gateway — ver seção 2, tabela: por que
#    `migrate` é seu próprio serviço one-off e não um passo do entrypoint do
#    gateway. Rodar isso com o gateway já escalado para N réplicas faria N
#    tentativas de migração simultâneas.)
docker compose run --rm migrate

# 3. Subir gateway + worker + reconciliation (postgres/redis também, se você
#    não estiver usando instâncias gerenciadas externas)
docker compose up -d gateway worker reconciliation
```

Ao atualizar para uma nova versão com migração de schema: `docker compose build`, depois `docker compose run --rm migrate` de novo (idempotente — `drizzle-orm`'s migrator só aplica as migrações que ainda não constam como aplicadas), só então `docker compose up -d` para trocar os containers de app.

## 5. Requisito de rede: `trustProxy`

O Gateway roda com `trustProxy: true` (Fastify, `server.ts`) — necessário para que `request.ip` e o rate-limit funcionem corretamente atrás de um proxy reverso real, mas **só é seguro se esse proxy sobrescrever (nunca repassar) um `X-Forwarded-For` vindo do cliente**. Se o Gateway for exposto diretamente à internet sem um proxy confiável na frente, um cliente poderia forjar seu próprio IP e escapar do rate-limit. Isso foi identificado e documentado na revisão de segurança da Fase 15 (`docs/SECURITY_REVIEW.md`, item 7) como um requisito de topologia de rede, não algo que o código resolva sozinho — a ação concreta desta fase é: **nunca aponte o proxy/load balancer real para o Gateway sem configurá-lo para sobrescrever esse header**.

## 6. TLS obrigatório para o Admin Dashboard

`/admin/*` (Fase 13) usa HTTP Basic Auth, que transmite as credenciais em Base64 — não criptografado — a cada requisição. Isso só é seguro sobre HTTPS. **Nunca exponha `/admin/*` (ou qualquer rota deste Gateway) sobre HTTP puro em produção.** O TLS é responsabilidade do proxy reverso da seção 5, não deste código.

## 7. Healthchecks

- `GET /health` — liveness (o processo está de pé; não verifica nenhuma dependência). Use para o orquestrador decidir se deve reiniciar o container.
- `GET /ready` — readiness (Postgres alcançável sempre; Redis alcançável também quando `REDIS_URL` está configurado — fechado nesta fase, ver `routes/health.ts`). Use para o orquestrador decidir se deve **rotear tráfego** para este container. Responde `503` com `{"status":"not_ready","reason":"database_unreachable"}` ou `{"status":"not_ready","reason":"redis_unreachable"}` quando a respectiva dependência não responde dentro de um orçamento de tempo curto (2s para o Redis — ver o comentário em `routes/health.ts` sobre por que esse timeout existe: sem ele, um Redis fora do ar travaria o endpoint inteiro em vez de falhar rápido, o que é pior do que não checar). `docker-compose.yml`'s healthcheck do serviço `gateway` já usa `/health`.

## 8. Rate limiting — recalibrar antes de escala real

Herdado da revisão de segurança da Fase 15 (item 9): o rate-limit atual é único e global (100 req/min por IP, aplicado a toda rota, incluindo `/webhooks/*` e `/admin/*`). Adequado para o volume de teste, mas não foi calibrado contra um perfil de tráfego real (nenhuma loja real conectada ainda em nenhuma fase deste projeto). Antes de um volume de produção real, considere limites por rota — em particular um limite mais permissivo para `/webhooks/*` (que pode ter picos legítimos em importações em massa do Shopify) e um mais restritivo para `/admin/*` (superfície privilegiada).

## 9. Logs

`server.ts` já redige `req.headers.authorization` e `req.headers['x-gateway-signature']` (cobre tanto o Basic Auth do Admin Dashboard quanto a assinatura HMAC interna). `sendMetaCapiEvent()` redige o access token do Meta de qualquer mensagem de erro de rede (Fase 15). Ainda assim, trate os logs de acesso do seu proxy reverso como sensíveis (retenção curta, acesso restrito) — o token de transferência cross-domain viaja como query param num redirect 302 (Fase 4/5), então a URL completa de um redirect pode aparecer em log de proxy/CDN mesmo que nunca apareça em log deste Gateway (risco residual aceito na Fase 15, item 8; mitigado por TTL curto, uso único e detecção de replay).

## 10. Rollback de schema

`drizzle-kit generate` (usado neste projeto) só gera migrações "para frente" — não existe uma migração "down" automática. Reverter um schema em produção significa escrever e aplicar uma nova migração para frente que desfaça a anterior, nunca "descer" uma migração já aplicada. Planeje isso ao escrever uma migração que remova uma coluna/tabela ainda em uso pela versão anterior do código, durante uma janela de deploy.

## 11. Checklist pós-deploy

1. `curl https://SEU_DOMINIO/health` → `{"status":"ok"}`.
2. `curl https://SEU_DOMINIO/ready` → `{"status":"ready"}` (se vier `503`, verifique `DATABASE_URL`/`REDIS_URL` antes de rotear tráfego real).
3. `curl https://SEU_DOMINIO/admin/dead-letters` sem credenciais → deve responder `401` (nunca `501`; `501` significa que `ADMIN_DASHBOARD_USERNAME`/`ADMIN_DASHBOARD_PASSWORD_HASH` não foram configurados) — confirma que o Admin Dashboard está no ar E protegido.
4. Disparar `POST /admin/reconciliation/run` (com credenciais) uma vez manualmente e conferir a resposta antes de depender só do cron — mais rápido que esperar o próximo tick de `RECONCILIATION_CRON` (default a cada 30 minutos).
5. Confirmar nos logs do worker que ele conectou ao Redis e está consumindo a fila `meta-capi-purchase` (nenhum job represado).

## 12. Limitação conhecida desta fase

O `docker build` completo (`apps/gateway/Dockerfile`) **não pôde ser executado de ponta a ponta neste ambiente de sandbox**: o registro `docker.io` (Docker Hub, de onde vem a imagem base `node:20-alpine`) está fora da lista de hosts permitidos pela política de rede deste ambiente de execução — uma restrição de política, não um bug a ser contornado. O Docker Compose está disponível aqui e `docker compose config` (com e sem o perfil `tools`) foi executado com sucesso contra os seis serviços deste arquivo, confirmando que a sintaxe, as dependências entre serviços e os healthchecks são válidos. O próprio `Dockerfile` foi revisado linha a linha contra a estrutura real de `dist/` já produzida por `npm run build` neste mesmo ambiente (confirmando que cada `COPY --from=builder` referencia um caminho que de fato existe: `packages/schema/dist`, `packages/db/dist` + `packages/db/migrations`, `apps/gateway/dist/{index,worker,reconciliationCron}.js`) e contra os `package.json` dos três workspaces que ele instala. Um `docker build` real (em CI, ou em qualquer máquina com acesso ao Docker Hub) é a validação final recomendada antes do primeiro deploy.
