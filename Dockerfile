# One image for every process (web, worker, gateway, migrate). Node runs the TypeScript directly,
# so there is no build step to drift: the image is the source plus the locked dependencies.
FROM node:24.19.0-alpine
RUN npm install -g pnpm@11.21.0 && mkdir /data && chown node:node /data
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod
COPY packages packages
COPY apps apps
ENV APP_ENV=production DATA_DIR=/data PORT=3000
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "apps/web/src/server.ts"]
