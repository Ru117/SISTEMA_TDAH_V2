# ---------- build: compila el front con Vite ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ---------- runtime: Nginx sirve client/dist y proxya la API ----------
FROM nginx:1.27-alpine AS runtime
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
