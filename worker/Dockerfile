# Git worker package runtime (monorepo root: docker build -f worker/Dockerfile .)
FROM node:22-alpine AS deps
RUN apk add --no-cache git
WORKDIR /app/worker
COPY worker/package.json ./package.json
COPY worker/package-lock.json ./package-lock.json
RUN npm ci

FROM deps AS build
COPY worker/ ./
RUN npm run build

FROM node:22-alpine AS runner
RUN apk add --no-cache git
WORKDIR /app/worker
ENV NODE_ENV=production
COPY worker/package.json ./package.json
COPY worker/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/worker/dist ./dist
CMD ["node", "dist/main.js"]
