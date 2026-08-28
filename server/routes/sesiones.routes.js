import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';
import { uploadCSV } from '../middlewares/upload.js';
import { manejarErrorServidor } from '../middlewares/manejarError.js';
import { CLASES } from './predicciones.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RAIZ_PROYECTO = path.join(__dirname, '..');

const router = Router();
router.post('/iniciar-sesion', async (req, res) => {
    try {
        const { pacienteId, dispositivoId, nombrePaciente } = req.body;
        const query = `INSERT INTO sesiones_paciente 
            (paciente_id, dispositivo_id, nombre_paciente, fecha_hora, diagnostico) 
            VALUES (?, ?, ?, NOW(), 'Sin diagnóstico')`;
        const [result] = await pool.query(query, [
            pacienteId || null,
            dispositivoId || null,
            nombrePaciente || null
        ]);
        res.status(200).json({ success: true, idSesion: result.insertId });
    } catch (error) {
        manejarErrorServidor(res, error, 'POST /api/iniciar-sesion');
    }
});

function numeroSeguro(valor, porDefecto = 0) {
    const n = parseFloat(valor);
    return Number.isFinite(n) ? n : porDefecto;
}

function interrupcionABooleanoSeguro(valor) {
    return (valor === '1' || valor === 1 || valor === true || valor === 'true') ? 1 : 0;
}

router.post(
    '/guardar-sesion-completa',
    uploadCSV.fields([
        { name: 'archivo_csv', maxCount: 1 },
        { name: 'archivos_csv_pruebas', maxCount: 10 }
    ]),
    async (req, res) => {

        const {
            idSesion, pacienteId, dispositivoId, nombrePaciente,
            duracionTotal, totalPruebas, avgAlpha, avgBeta, avgTheta,
            pruebasDetalle, evolucionBandas, interrupcionConexion,
            indicesCSVPruebas //posición en archivos_csv_pruebas, mandado por el frontend corregido
        } = req.body;

        const archivoCSVSesion = req.files?.archivo_csv?.[0] || null;
        const archivosCSVPruebas = req.files?.archivos_csv_pruebas || [];

        let mapaIndiceArchivo = null;
        if (indicesCSVPruebas) {
            try {
                const indices = typeof indicesCSVPruebas === 'string'
                    ? JSON.parse(indicesCSVPruebas)
                    : indicesCSVPruebas;
                mapaIndiceArchivo = new Map();
                indices.forEach((idxReal, posicionEnArchivos) => {
                    mapaIndiceArchivo.set(idxReal, archivosCSVPruebas[posicionEnArchivos]);
                });
            } catch (e) {
                console.error('No se pudo parsear indicesCSVPruebas:', e);
            }
        }

        const rutaCSVParaBD = archivoCSVSesion ? `uploads/${archivoCSVSesion.filename}` : null;

        const duracionTotalNum = numeroSeguro(duracionTotal);
        const totalPruebasNum = parseInt(totalPruebas, 10) || 0;
        const avgAlphaNum = numeroSeguro(avgAlpha);
        const avgBetaNum = numeroSeguro(avgBeta);
        const avgThetaNum = numeroSeguro(avgTheta);
        const interrupcionConexionNum = interrupcionABooleanoSeguro(interrupcionConexion);

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            let idSesionCreada;
            let duracionPrevia = 0; // segundos que ya tenía la sesión ANTES de esta parte (0 si es sesión nueva)
            let datosGraficaPrevios = null;

            if (idSesion) {
                // se suma a lo que ya tenía la sesión, no se reemplaza (para cuando se reanuda una sesión incompleta)
                const [sesionPrevia] = await connection.query(
                    'SELECT duracion_total_seg, csv_ruta, datos_grafica FROM sesiones_paciente WHERE id_sesion = ?', [idSesion]
                );
                duracionPrevia = sesionPrevia[0]?.duracion_total_seg || 0;
                datosGraficaPrevios = sesionPrevia[0]?.datos_grafica || null;
                const duracionAcumulada = duracionPrevia + duracionTotalNum;
                const csvRutaFinal = rutaCSVParaBD || sesionPrevia[0]?.csv_ruta || null;

                const sqlUpdate = `UPDATE sesiones_paciente SET 
                paciente_id = ?, dispositivo_id = ?, nombre_paciente = ?, 
                duracion_total_seg = ?, csv_ruta = ?, interrupcion_conexion = ?
                WHERE id_sesion = ?`;

                await connection.query(sqlUpdate, [
                    pacienteId, dispositivoId, nombrePaciente,
                    duracionAcumulada, csvRutaFinal, interrupcionConexionNum, idSesion
                ]);

                idSesionCreada = idSesion;
            } else {
                const sqlSesion = `INSERT INTO sesiones_paciente 
                (paciente_id, dispositivo_id, nombre_paciente, duracion_total_seg, total_pruebas, avg_alpha, avg_beta, avg_theta, csv_ruta, interrupcion_conexion, diagnostico) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sin diagnóstico')`;

                const [result] = await connection.query(sqlSesion, [
                    pacienteId, dispositivoId, nombrePaciente, duracionTotalNum,
                    totalPruebasNum, avgAlphaNum, avgBetaNum, avgThetaNum, rutaCSVParaBD, interrupcionConexionNum
                ]);

                idSesionCreada = result.insertId;
            }

            if (pruebasDetalle) {
                const detalles = typeof pruebasDetalle === 'string' ? JSON.parse(pruebasDetalle) : pruebasDetalle;
                if (detalles.length > 0) {
                    const sqlDetalle = `INSERT INTO detalles_pruebas_sesion 
                        (sesion_id, nombre_prueba, segundo_inicio, duracion_neta_seg, avg_theta, avg_alpha, avg_beta, csv_ruta) VALUES ?`;

                    const valoresDetalle = detalles.map((p, i) => {
                        // ANTES asumía posición == índice, se desalineaba si el frontend saltaba una prueba sin CSV
                        const archivoDeEstaPrueba = mapaIndiceArchivo
                            ? (mapaIndiceArchivo.get(i) || null)
                            : (archivosCSVPruebas[i] || null);

                        const rutaCSVPrueba = archivoDeEstaPrueba ? `uploads/${archivoDeEstaPrueba.filename}` : null;

                        return [
                            idSesionCreada,
                            p.nombre,
                            numeroSeguro(p.inicioRelativo) + duracionPrevia,
                            numeroSeguro(p.duracionNeto),
                            numeroSeguro(p.avgTheta),
                            numeroSeguro(p.avgAlpha),
                            numeroSeguro(p.avgBeta),
                            rutaCSVPrueba
                        ];
                    });
                    await connection.query(sqlDetalle, [valoresDetalle]);
                }
            }

            // total_pruebas y promedios se recalculan desde detalles_pruebas_sesion para quedar correctos aunque la sesión se haya completado en varias partes
            await connection.query(
                `UPDATE sesiones_paciente s SET
                    total_pruebas = (SELECT COUNT(*) FROM detalles_pruebas_sesion WHERE sesion_id = ?),
                    avg_alpha = (SELECT AVG(avg_alpha) FROM detalles_pruebas_sesion WHERE sesion_id = ?),
                    avg_beta = (SELECT AVG(avg_beta) FROM detalles_pruebas_sesion WHERE sesion_id = ?),
                    avg_theta = (SELECT AVG(avg_theta) FROM detalles_pruebas_sesion WHERE sesion_id = ?)
                WHERE s.id_sesion = ?`,
                [idSesionCreada, idSesionCreada, idSesionCreada, idSesionCreada, idSesionCreada]
            );

            if (evolucionBandas) {
                let puntosNuevos = typeof evolucionBandas === 'string' ? JSON.parse(evolucionBandas) : evolucionBandas;

                if (duracionPrevia > 0) {
                    puntosNuevos = puntosNuevos.map(p => ({ ...p, t: parseFloat(p.t) + duracionPrevia }));
                }

                let puntosFinales = puntosNuevos;
                if (datosGraficaPrevios) {
                    const datosPrevios = typeof datosGraficaPrevios === 'string'
                        ? JSON.parse(datosGraficaPrevios)
                        : datosGraficaPrevios;
                    // Se concatena con lo previo en vez de sobrescribir, para no perder la gráfica al reanudar sesión
                    puntosFinales = [...datosPrevios, ...puntosNuevos];
                }

                await connection.query('UPDATE sesiones_paciente SET datos_grafica = ? WHERE id_sesion = ?', [JSON.stringify(puntosFinales), idSesionCreada]);
            }

            await connection.commit();

            res.status(200).json({
                success: true,
                mensaje: "Sesión sincronizada correctamente",
                idSesion: idSesionCreada
            });

        } catch (error) {
            await connection.rollback();
            manejarErrorServidor(res, error, 'POST /api/guardar-sesion-completa');
        } finally {
            connection.release();
        }
    });

router.get('/historial-paciente/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                s.*, 
                d.nombre AS nombre_dispositivo,
                (SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'nombre', dp.nombre_prueba, 
                        'inicio', dp.segundo_inicio, 
                        'duracion', dp.duracion_neta_seg,
                        'avg_theta', dp.avg_theta,
                        'avg_alpha', dp.avg_alpha,
                        'avg_beta', dp.avg_beta,
                        'csv_ruta', dp.csv_ruta
                    )
                ) FROM detalles_pruebas_sesion dp WHERE dp.sesion_id = s.id_sesion) as detalles_pruebas
            FROM sesiones_paciente s
            LEFT JOIN dispositivos d ON s.dispositivo_id = d.id
            WHERE s.paciente_id = ?
            ORDER BY s.fecha_hora DESC
        `;
        const [rows] = await pool.query(query, [id]);
        res.status(200).json(rows);
    } catch (error) {
        manejarErrorServidor(res, error, 'GET /api/historial-paciente/:id');
    }
});

// Compara las pruebas asignadas contra las que ya tiene esta sesión, para saber si quedó incompleta
router.get('/sesiones/:id/pruebas-faltantes', async (req, res) => {
    try {
        const { id } = req.params;

        const [sesionRows] = await pool.query(
            'SELECT paciente_id FROM sesiones_paciente WHERE id_sesion = ?', [id]
        );
        if (sesionRows.length === 0) return res.status(404).json({ error: 'Sesión no encontrada' });
        const pacienteId = sesionRows[0].paciente_id;

        const [asignadasRows] = await pool.query(
            `SELECT p.id, p.nombre FROM pruebas p
             JOIN paciente_prueba pp ON pp.prueba_id = p.id
             WHERE pp.paciente_id = ?`, [pacienteId]
        );

        const [hechasRows] = await pool.query(
            'SELECT DISTINCT nombre_prueba FROM detalles_pruebas_sesion WHERE sesion_id = ?', [id]
        );
        const nombresHechos = hechasRows.map(r => r.nombre_prueba);

        const pruebasFaltantes = asignadasRows.filter(p => !nombresHechos.includes(p.nombre));

        res.status(200).json({
            completa: pruebasFaltantes.length === 0,
            pacienteId,
            pruebasFaltantes,
            totalAsignadas: asignadasRows.length,
            totalHechas: nombresHechos.length
        });
    } catch (error) {
        manejarErrorServidor(res, error, 'GET /api/sesiones/:id/pruebas-faltantes');
    }
});

// Junta el CSV principal + el de cada prueba de una sesión en un solo archivo descargable
router.get('/sesiones/:id/descargar-csv-completo', async (req, res) => {
    try {
        const { id } = req.params;

        const [sesionRows] = await pool.query(
            'SELECT csv_ruta FROM sesiones_paciente WHERE id_sesion = ?', [id]
        );
        if (sesionRows.length === 0) return res.status(404).json({ error: 'Sesión no encontrada' });

        const [detallesRows] = await pool.query(
            `SELECT nombre_prueba, csv_ruta FROM detalles_pruebas_sesion 
             WHERE sesion_id = ? AND csv_ruta IS NOT NULL ORDER BY segundo_inicio ASC`, [id]
        );

        // el CSV de sesión si existe, si no los individuales por prueba
        const rutasParaJuntar = [];
        if (sesionRows[0].csv_ruta) {
            rutasParaJuntar.push(sesionRows[0].csv_ruta);
        } else {
            detallesRows.forEach(d => { if (d.csv_ruta) rutasParaJuntar.push(d.csv_ruta); });
        }

        if (rutasParaJuntar.length === 0) {
            return res.status(404).json({ error: 'No hay archivos CSV guardados para esta sesión' });
        }

        let encabezado = null;
        const bloques = [];

        for (const ruta of rutasParaJuntar) {
            const rutaCompleta = path.join(RAIZ_PROYECTO, ruta);
            if (!fs.existsSync(rutaCompleta)) continue;

            const contenido = fs.readFileSync(rutaCompleta, 'utf-8').replace(/^\uFEFF/, '');
            const lineas = contenido.split('\n').filter(l => l.trim() !== '');
            if (lineas.length === 0) continue;

            if (!encabezado) encabezado = lineas[0];
            for (let i = 1; i < lineas.length; i++) {
                bloques.push(lineas[i]);
            }
        }

        if (!encabezado) return res.status(404).json({ error: 'Los archivos CSV de esta sesión no se encontraron en el servidor' });

        const csvFinal = "\ufeff" + [encabezado, ...bloques].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="EEG_sesion_${id}_completa.csv"`);
        res.send(csvFinal);
    } catch (error) {
        manejarErrorServidor(res, error, 'GET /api/sesiones/:id/descargar-csv-completo');
    }
});


router.get('/sesiones/:id/evolucion', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(
            'SELECT datos_grafica FROM sesiones_paciente WHERE id_sesion = ?',
            [id]
        );

        if (rows.length === 0 || !rows[0].datos_grafica) {
            return res.status(404).json({ error: 'Sin datos de gráfica para esta sesión' });
        }

        const datos = typeof rows[0].datos_grafica === 'string'
            ? JSON.parse(rows[0].datos_grafica)
            : rows[0].datos_grafica;

        res.status(200).json(datos);
    } catch (error) {
        manejarErrorServidor(res, error, 'GET /api/sesiones/:id/evolucion');
    }
});

router.put('/sesiones/:id/diagnostico', async (req, res) => {

    try {
        const { id } = req.params;
        const getPrediction = await fetch(`http://127.0.0.1:${process.env.PORT}/api/inference/predict/${id}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        });
        const { comentario } = req.body;
        const prediction = await getPrediction.json();

        if (prediction.error) {
            return res.status(404).json({ error: prediction.error });
        }

        const resultadoIA = JSON.stringify(prediction);
        const probabilidades_promedio = prediction.probabilidades_promedio;

        const [clase, prob] = Object.entries(probabilidades_promedio)
            .reduce((max, actual) => (actual[1] > max[1] ? actual : max));

        if (comentario !== undefined) {
            await pool.query('UPDATE sesiones_paciente SET diagnostico = ?, comentario = ?, resultado_ia = ?, probability = ?  WHERE id_sesion = ?', [clase, comentario, resultadoIA, prob, id]);
        } else {
            await pool.query('UPDATE sesiones_paciente SET diagnostico = ?, resultado_ia = ?, probability = ? WHERE id_sesion = ?', [clase, resultadoIA, prob, id]);
        }
        res.json({
            success: true,
            clase,
            prob
        });
    } catch (error) {
        manejarErrorServidor(res, error, 'PUT /api/sesiones/:id/diagnostico');
    }
});

router.get('/ultimo-resultado/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(
            `SELECT diagnostico FROM sesiones_paciente WHERE paciente_id = ? ORDER BY fecha_hora DESC LIMIT 1`,
            [id]
        );
        if (rows.length === 0) return res.json({ diagnostico: null });
        res.json({ diagnostico: rows[0].diagnostico });
    } catch (error) {
        manejarErrorServidor(res, error, 'GET /api/ultimo-resultado/:id');
    }
});

router.delete('/sesiones/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [sesionRows] = await pool.query('SELECT csv_ruta FROM sesiones_paciente WHERE id_sesion = ?', [id]);
        const [detallesRows] = await pool.query('SELECT csv_ruta FROM detalles_pruebas_sesion WHERE sesion_id = ?', [id]);

        await pool.query('DELETE FROM detalles_pruebas_sesion WHERE sesion_id = ?', [id]);
        const [result] = await pool.query('DELETE FROM sesiones_paciente WHERE id_sesion = ?', [id]);

        if (result.affectedRows > 0) {
            const rutasABorrar = [
                ...(sesionRows.length > 0 && sesionRows[0].csv_ruta ? [sesionRows[0].csv_ruta] : []),
                ...detallesRows.filter(d => d.csv_ruta).map(d => d.csv_ruta)
            ];

            rutasABorrar.forEach((ruta) => {
                const rutaCompleta = path.join(RAIZ_PROYECTO, ruta);
                fs.unlink(rutaCompleta, (err) => {
                    if (err) console.error('No se pudo borrar el CSV físico:', rutaCompleta, err.message);
                });
            });

            res.json({ success: true, message: "Sesión eliminada" });
        } else {
            res.status(404).json({ success: false, message: "No se encontró la sesión" });
        }
    } catch (error) {
        manejarErrorServidor(res, error, 'DELETE /api/sesiones/:id');
    }
});

export default router;