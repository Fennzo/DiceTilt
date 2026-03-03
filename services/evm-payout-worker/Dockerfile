FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared-types/package.json packages/shared-types/
COPY services/evm-payout-worker/package.json services/evm-payout-worker/
RUN pnpm install

COPY packages/shared-types/ packages/shared-types/
COPY services/evm-payout-worker/ services/evm-payout-worker/

RUN npx tsc -p packages/shared-types/tsconfig.json && \
    npx tsc -p services/evm-payout-worker/tsconfig.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/evm-payout-worker/dist ./dist
COPY --from=builder /app/services/evm-payout-worker/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types ./node_modules/@dicetilt/shared-types
CMD ["node", "dist/index.js"]
