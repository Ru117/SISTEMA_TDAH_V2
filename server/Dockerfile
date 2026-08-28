# ---------- deps: instala node_modules de producción (incluye binarios nativos) ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app/server

# Toolchain por si bcrypt / onnxruntime-node necesitan compilar en el fallback de node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server

# libgomp1: requerida por onnxruntime-node (OpenMP)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps /app/server/node_modules ./node_modules
# Incluye server/uploads (imágenes/CSVs ya existentes) y server/weights (modelo ONNX)
COPY server/ ./

RUN mkdir -p uploads weights/onnx

EXPOSE 3000
CMD ["node", "server.js"]
