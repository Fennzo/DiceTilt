FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/logger/package.json packages/logger/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/provably-fair/package.json services/provably-fair/
RUN pnpm install

COPY packages/shared-types/ packages/shared-types/
COPY packages/logger/ packages/logger/
COPY services/api-gateway/ services/api-gateway/

RUN npx tsc -p packages/shared-types/tsconfig.json && \
    npx tsc -p packages/logger/tsconfig.json && \
    npx tsc -p services/api-gateway/tsconfig.json

WORKDIR /app/services/api-gateway
EXPOSE 3000
CMD ["node", "dist/index.js"]
