import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { session } from '../config/onnx_models.js';
import { pool } from '../config/db.js';
import { manejarErrorServidor } from '../middlewares/manejarError.js';

const router = Router();

// ---------------------------------------------------------------------------
// Config del modelo -- mismo orden de features y mismo epoching que
// entrenar_modelo_onnx.py / flatten_eeg_sesiones.py (Python). Si cambias el
// entrenamiento, actualiza esto tambien.
// ---------------------------------------------------------------------------
const EPOCH_SECONDS = 2.0;
const CH_SUFFIXES = ['tp9', 'af7', 'af8', 'tp10'];

const FEATURE_COLS = [];
for (const ch of CH_SUFFIXES) {
    FEATURE_COLS.push(`rel_theta_${ch}`, `rel_alpha_${ch}`, `rel_beta_${ch}`, `theta_beta_ratio_${ch}`);
}

// Mapeo indice -> etiqueta, tal como lo genera clases.txt al entrenar.
// TODO: si config/onnx_models.js ya expone este mapeo (recomendado, para no
// tener dos fuentes de verdad), importalo de ahi en vez de hardcodearlo aqui:
//   import { session, clases } from '../config/onnx_models.js';
export const CLASES = { 0: 'TDAH Combinado', 1: 'TDAH Hiperactivo', 2: 'TDAH Inatento', 3: 'Sin TDAH' };

const RAIZ_PROYECTO = process.cwd(); // ajusta si tu proyecto define esto distinto

// ---------------------------------------------------------------------------
// Parsing CSV (misma logica que predecir_sesion.js, adaptada para operar
// sobre contenido en memoria en vez de una sola ruta de archivo, porque una
// sesion puede venir de varios CSVs juntados)
// ---------------------------------------------------------------------------
function parsearCSV(contenido) {
    const limpio = contenido.replace(/^\uFEFF/, '');
    const lineas = limpio.split('\n').filter((l) => l.trim() !== '');
    const encabezado = lineas[0].split(',');

    const filas = [];
    for (let i = 1; i < lineas.length; i++) {
        const valores = lineas[i].split(',');
        const fila = {};
        for (let j = 0; j < encabezado.length; j++) {
            const col = encabezado[j];
            fila[col] = col === 'marker' ? valores[j] : Number(valores[j]);
        }
        filas.push(fila);
    }
    return filas;
}

function tagConditions(filas) {
    const condicion = new Array(filas.length).fill('baseline');
    for (let i = 0; i < filas.length; i++) {
        const marker = filas[i].marker;
        if (marker && marker.includes('_START')) {
            const condName = marker.replace('_START', '');
            let endIdx = filas.length - 1;
            for (let k = i + 1; k < filas.length; k++) {
                const m = filas[k].marker;
                if (m && m.startsWith(condName + '_END')) {
                    endIdx = k;
                    break;
                }
            }
            for (let k = i; k <= endIdx; k++) condicion[k] = condName;
        }
    }
    return condicion;
}

function detectarValorValidoArtefacto(filas) {
    let count0 = 0;
    let count1 = 0;
    for (const f of filas) {
        if (f.artefacto === 0) count0++;
        else if (f.artefacto === 1) count1++;
    }
    const total = count0 + count1;
    const valorValido = count1 >= count0 ? 1 : 0;
    const pct = total ? (100 * Math.max(count0, count1)) / total : 0;
    return { valorValido, pct };
}

function epocarYExtraerFeatures(filas, valorValidoArtefacto) {
    const condiciones = tagConditions(filas);
    const filasValidas = [];
    const condicionValidas = [];
    for (let i = 0; i < filas.length; i++) {
        if (filas[i].artefacto === valorValidoArtefacto) {
            filasValidas.push(filas[i]);
            condicionValidas.push(condiciones[i]);
        }
    }
    if (filasValidas.length === 0) return [];

    const t0 = filasValidas[0].timestamp;
    const grupos = new Map();
    for (let i = 0; i < filasValidas.length; i++) {
        const f = filasValidas[i];
        const epochId = Math.floor((f.timestamp - t0) / 1000.0 / EPOCH_SECONDS);
        const key = `${epochId}|${condicionValidas[i]}`;
        if (!grupos.has(key)) grupos.set(key, []);
        grupos.get(key).push(f);
    }

    const epocas = [];
    for (const g of grupos.values()) {
        if (g.length < 3) continue;
        const ultimaFila = g[g.length - 1]; // bandas se actualizan lento -> ultimo valor valido de la ventana
        const featureRow = {};
        for (const ch of CH_SUFFIXES) {
            const theta = ultimaFila[`theta_${ch}`];
            const alpha = ultimaFila[`alpha_${ch}`];
            const beta = ultimaFila[`beta_${ch}`];
            const total = theta + alpha + beta;
            featureRow[`rel_theta_${ch}`] = total ? theta / total : NaN;
            featureRow[`rel_alpha_${ch}`] = total ? alpha / total : NaN;
            featureRow[`rel_beta_${ch}`] = total ? beta / total : NaN;
            featureRow[`theta_beta_ratio_${ch}`] = beta ? theta / beta : NaN;
        }
        epocas.push(featureRow);
    }
    return epocas;
}

// ---------------------------------------------------------------------------
// Inferencia con la sesion ONNX ya cargada (compartida via config/onnx_models.js
// -- no se crea una InferenceSession nueva en cada request)
// ---------------------------------------------------------------------------
async function predecirDesdeEpocas(epocas) {
    const epocasValidas = epocas.filter((e) => FEATURE_COLS.every((c) => Number.isFinite(e[c])));
    if (epocasValidas.length === 0) {
        throw new Error('No quedaron epocas validas para predecir (revisa artefacto/duracion de la sesion).');
    }

    const nFeatures = FEATURE_COLS.length;
    const nEpocas = epocasValidas.length;
    const inputData = new Float32Array(nEpocas * nFeatures);
    for (let i = 0; i < nEpocas; i++) {
        for (let j = 0; j < nFeatures; j++) {
            inputData[i * nFeatures + j] = epocasValidas[i][FEATURE_COLS[j]];
        }
    }

    const ort = await import('onnxruntime-node');
    const inputName = session.inputNames[0];
    const tensor = new ort.Tensor('float32', inputData, [nEpocas, nFeatures]);
    const salida = await session.run({ [inputName]: tensor });

    const outputNames = session.outputNames;
    const etiquetasIdx = Array.from(salida[outputNames[0]].data);

    let probsPromedio = null;
    if (outputNames.length > 1) {
        const nClases = Object.keys(CLASES).length;
        const probsData = salida[outputNames[1]].data;
        if (probsData.length === nEpocas * nClases) {
            probsPromedio = new Array(nClases).fill(0);
            for (let i = 0; i < nEpocas; i++) {
                for (let c = 0; c < nClases; c++) {
                    probsPromedio[c] += probsData[i * nClases + c] / nEpocas;
                }
            }
        }
    }

    const conteo = {};
    for (const idx of etiquetasIdx) conteo[idx] = (conteo[idx] || 0) + 1;
    const votosPorClase = Object.entries(conteo)
        .sort((a, b) => b[1] - a[1])
        .map(([idx, n]) => ({
            clase: CLASES[idx],
            epocas: n,
            porcentaje: Number(((100 * n) / etiquetasIdx.length).toFixed(1)),
        }));

    const prediccion = votosPorClase[0].clase;

    const probabilidades = probsPromedio
        ? Object.fromEntries(Object.entries(CLASES).map(([idx, nombre]) => [nombre, Number(probsPromedio[idx].toFixed(3))]))
        : null;

    return {
        prediccion,
        votos_por_clase: votosPorClase,
        probabilidades_promedio: probabilidades,
        n_epocas: etiquetasIdx.length,
        confianza_baja: etiquetasIdx.length < 10, // avisa si hay muy poca evidencia detras de la prediccion
    };
}

// ---------------------------------------------------------------------------
// Junta el/los CSV de una sesion -- variante interna (no expuesta como ruta)
// del GET /:id/descargar-csv-completo que ya existe en otro archivo. La
// diferencia es que aqui el CSV combinado se queda en memoria del servidor
// para alimentar al modelo, en vez de mandarse al cliente como descarga.
// ---------------------------------------------------------------------------
async function obtenerCSVUnificado(idSesion) {
    const [sesionRows] = await pool.query('SELECT csv_ruta FROM sesiones_paciente WHERE id_sesion = ?', [idSesion]);
    if (sesionRows.length === 0) {
        const err = new Error('Sesión no encontrada');
        err.status = 404;
        throw err;
    }

    const [detallesRows] = await pool.query(
        `SELECT nombre_prueba, csv_ruta FROM detalles_pruebas_sesion 
         WHERE sesion_id = ? AND csv_ruta IS NOT NULL ORDER BY segundo_inicio ASC`,
        [idSesion]
    );

    const rutasParaJuntar = [];
    if (sesionRows[0].csv_ruta) {
        rutasParaJuntar.push(sesionRows[0].csv_ruta);
    } else {
        detallesRows.forEach((d) => {
            if (d.csv_ruta) rutasParaJuntar.push(d.csv_ruta);
        });
    }

    if (rutasParaJuntar.length === 0) {
        const err = new Error('No hay archivos CSV guardados para esta sesión');
        err.status = 404;
        throw err;
    }

    let encabezado = null;
    const bloques = [];

    for (const ruta of rutasParaJuntar) {
        const rutaCompleta = path.join(RAIZ_PROYECTO, ruta);
        if (!fs.existsSync(rutaCompleta)) continue;

        const contenido = fs.readFileSync(rutaCompleta, 'utf-8').replace(/^\uFEFF/, '');
        const lineas = contenido.split('\n').filter((l) => l.trim() !== '');
        if (lineas.length === 0) continue;

        if (!encabezado) encabezado = lineas[0];
        for (let i = 1; i < lineas.length; i++) bloques.push(lineas[i]);
    }

    if (!encabezado) {
        const err = new Error('Los archivos CSV de esta sesión no se encontraron en el servidor');
        err.status = 404;
        throw err;
    }

    return [encabezado, ...bloques].join('\n');
}

// ---------------------------------------------------------------------------
// POST /predict/:id -- corre el modelo sobre los CSV de la sesion y devuelve
// la prediccion en JSON.
// ---------------------------------------------------------------------------
router.post('/predict/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const csvUnificado = await obtenerCSVUnificado(id);
        const filas = parsearCSV(csvUnificado);

        const { valorValido, pct } = detectarValorValidoArtefacto(filas);
        const epocas = epocarYExtraerFeatures(filas, valorValido);

        if (epocas.length === 0) {
            return res.status(422).json({
                error: 'No se generaron epocas validas a partir del CSV (revisa duracion/calidad de la sesion)',
            });
        }

        const resultado = await predecirDesdeEpocas(epocas);

        res.json({
            sesion_id: id,
            artefacto_convencion_detectada: { valor_valido: valorValido, porcentaje: Number(pct.toFixed(1)) },
            ...resultado,
        });
    } catch (error) {
        if (error.status === 404) return res.status(404).json({ error: error.message });
        manejarErrorServidor(res, error, 'POST /api/sesiones/predict/:id');
    }
});

export default router;