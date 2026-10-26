# Build from the repository root: docker compose -f examples/demo/compose.yml up --build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter demo build \
 && pnpm --filter demo deploy --prod /app \
 && cp -R examples/demo/dist examples/demo/prisma examples/demo/prisma.config.ts examples/demo/tenants.config.ts examples/demo/scripts /app/

FROM node:22-alpine
WORKDIR /app
# Runtime needs no package manager: binaries are called from node_modules/.bin.
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
USER node
EXPOSE 3000
CMD ["sh", "scripts/provision.sh"]
