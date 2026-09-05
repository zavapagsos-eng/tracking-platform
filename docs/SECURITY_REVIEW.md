# Revisão de Segurança — Fase 15

Revisão do código entregue nas Fases 0–14 contra o checklist do spec (seções 41-45/63: segredos nunca no browser/payload de fila, HMAC em toda superfície privilegiada, consentimento antes de qualquer envio ao Meta, PII minimizada/isolada, auditoria). Cada item abaixo foi verificado lendo o código-fonte relevante, não assumido — igual ao padrão de pesquisa já estabelecido nas fases anteriores.

## Achados corrigidos nesta fase

### 1. Vazamento potencial do access token do Meta em mensagem de erro de rede (corrigido)

`lib/metaCapiClient.ts`'s `sendMetaCapiEvent()` monta a URL do Meta CAPI com `access_token` como query param — a única forma documentada de autenticar essa API (verificado na Fase 10). Se a chamada `fetch()` falhar por erro de rede, `err.message` (de algumas implementações de fetch/undici, em certas cadeias de causa) pode embutir a URL completa da requisição que falhou — o que incluiria o token. Esse `error` é devolvido para quem chama e **persistido em `dead_letters.failure_reason` (Postgres)** pelo worker (Fase 11), e pode chegar a logs.

Este projeto nunca observou esse vazamento ocorrer na prática (os testes de erro de rede usam mensagens genéricas tipo `ENOTFOUND`), mas o princípio do projeto é nunca confiar cegamente no formato de mensagem de erro de uma dependência de runtime para continuar seguro. **Corrigido**: a mensagem de erro agora tem o valor exato do `access_token` removido (substituído por `[REDACTED]`) antes de ser retornada, sempre — defesa em profundidade, não uma correção reativa a um vazamento real observado. Teste novo em `lib/metaCapiClient.test.ts` simulando exatamente esse cenário (mensagem de erro contendo a URL completa).

### 2. `drizzle-orm` — CVE de SQL injection via identificadores mal escapados (avaliado e corrigido)

`npm audit` reportou uma vulnerabilidade **high** em `drizzle-orm@<0.45.2` (GHSA-gpj5-g38j-94v9: "SQL injection via improperly escaped SQL identifiers").

**Avaliação de exploração real**: auditado todo uso de `sql\`...\`` (template tagged) neste projeto — existem exatamente dois locais (`lib/eventRegistry.ts`, `lib/identity.ts`), e em nenhum deles um identificador (nome de tabela/coluna) é construído a partir de uma string dinâmica/entrada externa: todos interpolam ou um objeto `Column` do próprio schema Drizzle (tipado em tempo de compilação, nunca uma string vinda do usuário) ou um valor booleano validado por Zod (vira parâmetro vinculado, nunca concatenado). Todo o resto do projeto usa exclusivamente o query builder tipado (`eq`, `and`, `or`, `.values()`, `.where()`) contra colunas de schema conhecidas em tempo de compilação — nenhuma rota deste Gateway jamais aceita um nome de tabela/coluna vindo do cliente. Conclusão: **nenhum caminho de código deste projeto é explorável** por essa CVE específica.

Mesmo assim, como a correção está disponível sem quebra de compatibilidade observável neste projeto, `drizzle-orm` foi atualizado de `^0.36.4` para `^0.45.2` (e `drizzle-kit` de `^0.28.1` para `^0.31.10`, para acompanhar) — build, `drizzle-kit generate` (sem gerar migration nova, confirmando zero drift de schema) e os 218 testes do monorepo inteiro re-executados com sucesso após a troca, sem nenhuma regressão.

## Achados revisados e aceitos (nenhuma mudança de código necessária)

### 3. Demais vulnerabilidades do `npm audit` — apenas ferramental de desenvolvimento

Após a correção do item 2, `npm audit` ainda reporta 8 vulnerabilidades (6 moderate, 1 high, 1 critical). Investigação por `npm audit --json` confirma que **todas** vêm de uma única cadeia: `esbuild` (usado pelo dev-server do `vitest`/`vite` e pelo `@esbuild-kit/esm-loader` do `drizzle-kit`) e o próprio `vitest`/`vite`/`vite-node`. Os avisos descrevem especificamente um servidor de desenvolvimento HTTP aceitando requisições arbitrárias e um "Vitest UI server" — este projeto nunca roda `vite`/`esbuild` como servidor (nenhum script usa `--ui` ou um dev-server do Vite/esbuild) e nenhum desses pacotes é uma dependência de produção: o artefato implantado roda `node dist/*.js` compilado, sem nenhuma ferramenta de build presente. Risco real: nenhum, no ambiente de produção. Aceito sem correção — forçar `vitest@5` (mudança incompatível) para eliminar um aviso sem exposição real seria desproporcional.

### 4. Verificação de HMAC/assinaturas — já correta em todos os pontos

Auditados os três mecanismos de assinatura deste projeto (`lib/crypto.ts::verifyHmac`, `lib/shopifyWebhookAuth.ts::verifyShopifyWebhookHmac`, `lib/appProxy.ts::verifyAppProxySignature`): todos usam `crypto.timingSafeEqual` (nunca `===`), todos checam o comprimento do buffer ANTES de comparar (evitando um erro de `timingSafeEqual` em buffers de tamanho diferente, e evitando um curto-circuito que vazaria informação de tamanho), e todos capturam erros de decodificação (base64/hex malformado) retornando `false` em vez de lançar. Nenhuma mudança necessária — já estava correto desde a Fase 3/4/7.

### 5. Consentimento e PII — já corretos

`sendPurchaseToMeta()` (Fase 10) recusa enviar ao Meta sem consentimento de marketing vigente (`consent !== "granted"` → `consent_not_granted`, nunca enviado). `identity_private` guarda apenas hashes SHA-256 de e-mail/telefone (`lib/metaNormalization.ts`), nunca texto puro — os campos `first_name_enc`/`last_name_enc`/`address_enc` reservados no schema (para uma futura melhoria de EMQ, Fase 10) **nunca são escritos por nenhum código atual**, então não há risco de PII em texto puro nessas colunas hoje — é um design correto para uma feature ainda não construída, não uma vulnerabilidade. Os handlers GDPR (`customers/data_request`/`customers/redact`/`shop/redact`, Fase 7) gravam auditoria apenas com o `customer_id`, nunca e-mail/telefone do payload Shopify — confirmado por teste (`server.test.ts`).

### 6. Admin Dashboard — HTTP Basic Auth (Fase 13), avaliação de suficiência

Falha fechado (501) sem credenciais configuradas; senha nunca comparada em texto puro (bcrypt); usuário comparado em tempo constante. **Requisito operacional, não de código**: HTTP Basic Auth transmite as credenciais em Base64 (não criptografado) a cada requisição — isso só é seguro sobre HTTPS. Nenhum código aqui força TLS (isso é responsabilidade da camada de deployment/proxy reverso) — documentado como requisito explícito na Fase 16 (nunca expor `/admin/*` sobre HTTP puro em produção).

## Achados documentados como risco residual aceito / recomendação operacional

### 7. `trustProxy: true` (Fastify) confia cegamente em `X-Forwarded-For`

Necessário para que `request.ip`/rate-limit funcionem corretamente atrás de um proxy reverso real (Railway, Fase 16), mas só é seguro quando o proxy à frente do Gateway **sobrescreve** (nunca repassa) um `X-Forwarded-For` vindo do cliente. Se o Gateway algum dia for exposto diretamente à internet sem um proxy confiável na frente, esta configuração permitiria um cliente forjar seu próprio IP (afetando rate-limit e qualquer log/decisão baseada em IP). Ação: documentado como requisito de topologia de rede na Fase 16 (docs/DEPLOYMENT.md), não alterado no código — mudar para uma lista de hops confiáveis específica exigiria conhecer a infraestrutura real de produção, que ainda não existe.

### 8. Token de transferência cross-domain carregado como parâmetro de URL num redirect

O design (Fase 4/5, `GET /r/:token`) coloca o token de transferência (opaco, hash armazenado, nunca a versão crua) no cart attribute via `Location` header do redirect 302. Se logs de acesso/proxy capturarem a URL completa do redirect, um token ainda não resgatado poderia teoricamente ser reproduzido antes do resgate legítimo. Mitigado por: TTL curto (default 600s), uso único com resgate atômico (guarda contra corrida), e detecção de replay (`transfer_replay_detected` já auditado). Risco residual aceito, inerente a qualquer esquema bearer-token-em-URL — recomendação: tratar logs de acesso como sensíveis (retenção curta, acesso restrito) na configuração de produção, não algo que este código possa resolver sozinho.

### 9. Rate limiting único e global (100 req/min)

Aplicado uniformemente a toda rota, incluindo `/webhooks/*` (que pode ter picos legítimos em importações em massa do Shopify) e `/admin/*` (que idealmente seria mais restritivo, já que é superfície privilegiada). Adequado para o volume de teste atual; recomendado calibrar limites por rota antes de produção em escala — não alterado agora por falta de um perfil de tráfego real para calibrar contra (nenhuma loja real conectada ainda).

## Itens já adequados por padrão (verificados, sem ação)

- **Limite de tamanho de payload**: Fastify aplica um `bodyLimit` padrão de 1MB — nenhuma rota o desabilita ou aumenta.
- **CORS**: falha fechado — `CORS_ALLOWLIST` vazio resulta em `origin: false` (CORS completamente desabilitado), nunca um fallback permissivo.
- **Helmet**: aplicado globalmente com os defaults (inclui HSTS) — adequado para uma API JSON pura sem respostas HTML.
- **Nenhum handler de erro customizado**: o handler padrão do Fastify nunca envia stack traces ao cliente (só loga server-side) — confirmado, nenhum `setErrorHandler` sobrepõe esse comportamento.
- **Redação de logs**: `req.headers.authorization` e `req.headers['x-gateway-signature']` já redigidos na config do logger (`server.ts`) — as credenciais do Admin Dashboard (Fase 13) e a assinatura HMAC interna nunca aparecem em log, confirmado ao adicionar as novas rotas.

## Resultado

Nenhuma regressão: build, lint, typecheck e os 218 testes do monorepo passam após as duas correções desta fase (redação do access token, upgrade do drizzle-orm/drizzle-kit). Nenhuma vulnerabilidade `npm audit` com exposição real em produção permanece.
