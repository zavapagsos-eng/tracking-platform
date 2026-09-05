# Build from the monorepo root: `docker build -f apps/gateway/Dockerfile .`
# (this is what docker-compose.yml's `build.context: .` does).

FROM node:20-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/schema/package.json packages/schema/package.json
COPY packages/db/package.json packages/db/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN npm install

COPY tsconfig.base.json ./
COPY packages/schema packages/schema
COPY packages/db packages/db
COPY apps/gateway apps/gateway
RUN npm run build -w @tracking/schema -w @tracking/db -w @tracking/gateway

FROM node:20-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/schema/package.json packages/schema/package.json
COPY packages/db/package.json packages/db/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN npm install --omit=dev

COPY --from=builder /repo/packages/schema/dist packages/schema/dist
COPY --from=builder /repo/packages/db/dist packages/db/dist
COPY --from=builder /repo/packages/db/migrations packages/db/migrations
COPY --from=builder /repo/apps/gateway/dist apps/gateway/dist

EXPOSE 3000
USER node
CMD ["node", "apps/gateway/dist/index.js"]
