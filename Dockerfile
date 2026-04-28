# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Production stage - use playwright base image for browser support
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runner

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

# Playwright image comes with Node.js and pwuser (uid 1000)
# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Set ownership to pwuser (playwright's default non-root user)
RUN chown -R pwuser:pwuser /app

USER pwuser

# Default to API mode, can be overridden to "worker"
ENV NODE_ENV=production
ENV MODE=api

EXPOSE 8787

# Use dumb-init for proper PID 1 behavior and signal forwarding
ENTRYPOINT ["dumb-init", "--"]

# Start based on MODE env var
# `exec` replaces the shell so node receives signals directly from dumb-init
CMD ["sh", "-c", "if [ \"$MODE\" = \"worker\" ]; then exec node $NODE_OPTIONS dist/worker.js; else exec node $NODE_OPTIONS dist/index.js; fi"]
