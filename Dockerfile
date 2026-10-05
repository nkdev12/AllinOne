# Multi-stage build for production

# ============================================================================
# Build stage
# ============================================================================
FROM node:22-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache openssl python3 make g++

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src
COPY tsconfig.json ./
COPY prisma ./prisma

# Generate Prisma client
RUN npm run db:generate

# Build TypeScript
RUN npm run build

# Prune devDependencies to keep only production dependencies (with compiled native modules)
RUN npm prune --omit=dev && npm cache clean --force

# ============================================================================
# Runtime stage
# ============================================================================
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling and openssl for Prisma runtime
RUN apk add --no-cache dumb-init curl openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copy package files
COPY --chown=nodejs:nodejs package.json ./

# Copy compiled production dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /build/node_modules ./node_modules

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /build/dist ./dist

# Copy Prisma schema for migrations
COPY --chown=nodejs:nodejs prisma ./prisma

# Switch to non-root user
USER nodejs

# Health check
# /health/live is the liveness probe: it answers 200 as soon as the HTTP server
# is up and never touches Mongo/Redis. /health/ready does check dependencies, so
# using it here would have Docker kill a healthy container over a degraded DB.
# (There is no global route prefix -- /api is only the Swagger UI mount.)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health/live || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default command
CMD ["node", "dist/main.js"]
