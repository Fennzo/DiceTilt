FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/logger/package.json packages/logger/
COPY services/ledger-consumer/package.json services/ledger-consumer/
RUN pnpm install

COPY packages/shared-types/ packages/shared-types/
COPY packages/logger/ packages/logger/
COPY services/ledger-consumer/ services/ledger-consumer/

RUN npx tsc -p packages/shared-types/tsconfig.json && \
    npx tsc -p packages/logger/tsconfig.json && \
    npx tsc -p services/ledger-consumer/tsconfig.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/ledger-consumer/dist ./dist
COPY --from=builder /app/services/ledger-consumer/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types ./node_modules/@dicetilt/shared-types
COPY --from=builder /app/packages/logger ./node_modules/@dicetilt/logger
CMD ["node", "dist/index.js"]
