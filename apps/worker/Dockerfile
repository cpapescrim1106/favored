# Favored Worker - Production Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package.json turbo.json ./
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Install dependencies
RUN npm ci

# Copy source code
COPY apps/worker apps/worker
COPY apps/web/prisma apps/web/prisma
COPY packages/shared packages/shared

# Build shared package
RUN npm run build --workspace=@favored/shared

# Generate Prisma client
RUN npm run db:generate --workspace=@favored/web

# Build worker
RUN npm run build --workspace=@favored/worker

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 worker

# Copy built artifacts
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma
COPY --from=builder /app/apps/web/src/generated ./apps/web/src/generated
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

USER worker

CMD ["node", "apps/worker/dist/index.js"]
