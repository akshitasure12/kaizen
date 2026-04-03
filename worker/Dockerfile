# Git worker: same backend artifact + git CLI (monorepo root: docker build -f worker/Dockerfile .)
FROM node:22-alpine AS deps
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY worker/package.json ./worker/
COPY frontend/package.json ./frontend/
RUN npm ci

FROM deps AS build
COPY backend ./backend
WORKDIR /app/backend
RUN npm run build

FROM node:22-alpine AS runner
RUN apk add --no-cache git
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY worker/package.json ./worker/
COPY frontend/package.json ./frontend/
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/src/db/schema.sql ./backend/dist/db/schema.sql
WORKDIR /app/backend
CMD ["node", "dist/worker-cli.js"]
