# Build from monorepo root: docker build -f backend/Dockerfile .
FROM node:22-alpine AS deps
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
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY worker/package.json ./worker/
COPY frontend/package.json ./frontend/
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
WORKDIR /app/backend
EXPOSE 3001
CMD ["node", "dist/server.js"]
