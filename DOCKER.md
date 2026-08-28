# Despliegue con Docker

Tres servicios: **client** (Nginx sirve el build de Vite + proxy a la API),
**server** (Node/Express) y **db** (MySQL 8).

```
navegador ─▶ client:8080 ─┬─ /            → estáticos (client/dist)
                          ├─ /api/*       → server:3000
                          └─ /uploads/*   → server:3000
server:3000 ─▶ db:3306
```

## Requisitos previos

1. **Modelo ONNX**: `server/weights/onnx/modelo_tdah.onnx` debe existir en disco
   (está en `.gitignore`, no viaja en git). Se copia dentro de la imagen al construir.
2. **Dump de la base de datos**: coloca tu `.sql` en `db/init/`. Se ejecuta
   automáticamente **solo la primera vez** (cuando el volumen `db_data` está vacío).
3. **Variables de entorno**:

   ```bash
   cp .env.example .env
   ```

   Edita `.env`. Importante:
   - `RESEND_API_KEY` es **obligatoria** — el server no arranca si está vacía.
   - `DB_PORT=3307` si ya tienes MySQL local ocupando el 3306.

## Uso

```bash
docker compose up -d --build      # construir y levantar
docker compose logs -f server     # ver logs
docker compose ps                 # estado
docker compose down               # parar (conserva datos)
docker compose down -v            # parar y BORRAR datos (db + uploads)
```

Front: http://localhost:8080 · API directa: http://localhost:3000/api

## Notas

- **Persistencia**: volúmenes `db_data` (MySQL) y `uploads_data` (CSVs e imágenes
  subidas, montado en `/app/server/uploads`).
- **uploads iniciales**: el contenido de `server/uploads/` se copia dentro de la
  imagen y, en el **primer** arranque, Docker siembra con él el volumen
  `uploads_data`. Si ya habías levantado el stack antes, el volumen existe y no se
  vuelve a sembrar: bórralo una vez para forzarlo —
  `docker volume rm sistema_tdah_v2_uploads_data` (o `docker compose down -v`).
- **Cambiar el schema / re-cargar el dump**: `docker compose down -v` y volver a
  `up` (se pierde todo lo guardado), o importar a mano:
  `docker compose exec -T db mysql -uroot -p"$DB_PASSWORD" Proyecto_EEG < dump.sql`
- El server corre en modo `production` → sirve `client/dist`. El front real lo
  entrega Nginx; el `client/dist` dentro de la imagen del server es solo fallback.
- Imágenes base Debian (no Alpine) porque `onnxruntime-node` y `bcrypt` usan
  binarios nativos con glibc.
