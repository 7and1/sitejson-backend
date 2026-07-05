FROM mcr.microsoft.com/playwright:v1.58.2-noble AS base

COPY npm-10.9.8.tgz /tmp/npm-10.9.8.tgz
RUN npm install -g /tmp/npm-10.9.8.tgz --no-audit --no-fund && rm -f /tmp/npm-10.9.8.tgz

# Build stage
FROM base AS builder

WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN NODE_OPTIONS=--dns-result-order=ipv4first npm ci --ignore-scripts --no-audit --no-fund

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Production stage - use playwright base image for browser support
FROM base AS runner

WORKDIR /app

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Playwright image comes with Node.js and pwuser (uid 1000)
# Copy built files first so BuildKit does not run builder and runner npm installs concurrently.
COPY --from=builder /app/dist ./dist

# Copy package files and install production deps only.
COPY package*.json ./
RUN NODE_OPTIONS=--dns-result-order=ipv4first npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# Set ownership to pwuser (playwright's default non-root user)
RUN chown -R pwuser:pwuser /app

USER pwuser

# Default to API mode, can be overridden to "worker"
ENV NODE_ENV=production
ENV MODE=api

EXPOSE 8787

# Start based on MODE env var.
CMD ["sh", "-c", "if [ \"$MODE\" = \"worker\" ]; then exec node $NODE_OPTIONS dist/worker.js; else exec node $NODE_OPTIONS dist/index.js; fi"]
