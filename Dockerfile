# ---- deps layer -------------------------------------------------------------
# Cached. Only re-runs when package.json / package-lock.json change.
# Every code-only push skips npm install completely.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["npx","tsx","src/platform/server.ts"]
