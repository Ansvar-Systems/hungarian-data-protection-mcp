# ─────────────────────────────────────────────────────────────────────────────
# Hungarian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t hungarian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 hungarian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/naih.db.
# Override with NAIH_DB_PATH for a custom location.
#
# Multi-stage: stage 1 builds TS + runs better-sqlite3 postinstall (binding);
# stage 2 reuses node_modules from builder so the native binding survives.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native deps ---
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
# Run npm ci WITHOUT --ignore-scripts so better-sqlite3 postinstall fetches the binding
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV NAIH_DB_PATH=/app/data/naih.db

# Reuse node_modules from builder so better-sqlite3's native binding survives
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ dist/
COPY package.json ./

# Copy provisioned database (CI's "Provision database" step gunzips
# database.db.gz from the GitHub Release into data/database.db)
COPY data/database.db data/naih.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
