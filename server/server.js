import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import dispositivosRoutes from './routes/dispositivos.routes.js';
import pruebasRoutes from './routes/pruebas.routes.js';
import pacientesRoutes from './routes/pacientes.routes.js';
import sesionesRoutes from './routes/sesiones.routes.js';
import medicosRoutes from './routes/medicos.routes.js';
import statsRoutes from './routes/stats.routes.js';
import prediccionesRoutes from './routes/predicciones.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// En desarrollo, el front no está compilado: apunta a client/public
// (ahí vive todo el JS/CSS/HTML sin bundlear). En producción, apunta
// a client/dist (generado por "npm run build" dentro de client/).
const isProd = process.env.NODE_ENV === 'production';
const clientRoot = isProd
    ? path.join(__dirname, '../client/dist')
    : path.join(__dirname, '../client/public');

const app = express();

// --- 1. MIDDLEWARES Y CONFIGURACIÓN ---
app.use(cors());
app.use(express.json());

// --- 2. RUTAS DE LA API (SIEMPRE ANTES DE LOS ESTÁTICOS) ---
app.use('/api/dispositivos', dispositivosRoutes);
app.use('/api/pruebas', pruebasRoutes);
app.use('/api/stats-admin', statsRoutes);
app.use('/api', pacientesRoutes);
app.use('/api', sesionesRoutes);
app.use('/api', medicosRoutes);
app.use('/api/inference', prediccionesRoutes);

// --- 3. ARCHIVOS ESTÁTICOS (CSS, JS, IMÁGENES, Y LOS .HTML COMPILADOS) ---
app.use(express.static(clientRoot));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// En desarrollo (sin build), los .html sueltos viven en client/ (no en
// client/public), así que también los servimos desde ahí.
if (!isProd) {
    app.use(express.static(path.join(__dirname, '../client')));
}

// --- 4. FALLBACK: cualquier ruta no-api que no matcheó un archivo estático
app.get(/^\/(?!api).*/, (req, res) => {
    const target = req.path === '/' ? 'index.html' : req.path;
    res.sendFile(path.join(clientRoot, target), (err) => {
        if (err) {
            // último recurso: buscar el .html en la raíz de client/ (modo dev)
            res.sendFile(path.join(__dirname, '../client', target), (err2) => {
                if (err2) res.status(404).send('Página no encontrada');
            });
        }
    });
});

// --- 5. INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n SERVIDOR DETEC TDAH CORRIENDO EN: http://localhost:${PORT}`);
    console.log(`📂 Modo: ${isProd ? 'producción (client/dist)' : 'desarrollo (client/public + client/)'}`);
    console.log(`📂 Carpeta de subidas: ${path.join(__dirname, 'uploads')}`);
});
