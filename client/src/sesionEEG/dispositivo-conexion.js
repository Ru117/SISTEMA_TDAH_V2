import { MuseClient, zipSamples, channelNames } from "muse-js";
import { liveState } from './state.js';
import { sesionState } from './sesion-state.js';
import { showStatusMessage } from './ui.js';
import {
    resetearFiltros, applyFilters, computeBands, detectarArtefacto,
    calcularUmbralAmplitud, bufferSize, stepSize
} from './filtros-bandas.js';
import {
    initThreeJS, initChart, initEEGChart, updateChart,
    resetChartData, refreshEegChart, eegDataBuffer
} from './visual3d-graficas.js';

const NOMBRES_CANALES = ['tp9', 'af7', 'af8', 'tp10'];

let scene; // si el 3D ya se inicializó
let client; // instancia del dispositivo Muse

let museDevice = null; // dispositivo ya emparejado, sirve para reconectar sin pedirle permiso al usuario de nuevo

let subConexionRef = null; // suscripción al estado de conexión

let suscripcionesCanal = []; // suscripciones a los datos que llegan del Muse

let desconexionManual = false; // true si el usuario desconectó a propósito

// Buffers de señal filtrada usados para calcular bandas
let bandBuffers = { tp9: [], af7: [], af8: [], tp10: [] };
let ultimasBandas = { theta: 0, alpha: 0, beta: 0 };
let bandasDisponibles = false;    // ya hubo al menos un cálculo de bandas
let bandaFrescaPendiente = false; // hay un cálculo nuevo por guardar

// Calibración del umbral de artefacto, se hace una sola vez por sesión
const DURACION_CALIBRACION_MS = 30000; // 30 segundos
let calibrando = false;
let calibracionBuffer = { tp9: [], af7: [], af8: [], tp10: [] };
let umbralAmplitudCalibrado = null;
let calibracionValida = false;
let calibracionTimeoutId = null;

// Reconexión automática
const MAX_INTENTOS_RECONEXION = 10;
const INTERVALO_RECONEXION_MS = 3000; // 3s entre intentos
let reconectando = false;

// Corta la adquisición y desconecta el Muse
export function detenerAdquisicion() {
    if (subConexionRef) { try { subConexionRef.unsubscribe(); } catch (e) { /* ya estaba cerrada */ } }
    subConexionRef = null;
    suscripcionesCanal.forEach(s => { try { s.unsubscribe(); } catch (e) { /* ya estaba cerrada */ } });
    suscripcionesCanal = [];
    if (calibracionTimeoutId) { clearTimeout(calibracionTimeoutId); calibracionTimeoutId = null; }
    if (client) {
        try { client.disconnect(); } catch (e) { /* ya estaba desconectado */ }
    }
}

// Guarda una fila del CSV con la muestra actual
function guardarFilaCSV(timestamp, crudos, filtrados, artefactoMuestra) {
    if (!sesionState.recording) return;

    const bandaActualizada = bandaFrescaPendiente ? 1 : 0;
    bandaFrescaPendiente = false;

    const porCanal = ultimasBandas.porCanal;
    // Solo se guarda el valor de banda cuando es un cálculo nuevo, para no repetirlo en cada fila
    const col = (v) => bandaActualizada ? v.toFixed(2) : "";

    const row = [
        timestamp,
        crudos.tp9.toFixed(2), crudos.af7.toFixed(2), crudos.af8.toFixed(2), crudos.tp10.toFixed(2),
        col(ultimasBandas.theta),
        col(ultimasBandas.alpha),
        col(ultimasBandas.beta),
        bandasDisponibles ? col(porCanal.tp9.theta_pct) : "",
        bandasDisponibles ? col(porCanal.tp9.alpha_pct) : "",
        bandasDisponibles ? col(porCanal.tp9.beta_pct) : "",
        bandasDisponibles ? col(porCanal.af7.theta_pct) : "",
        bandasDisponibles ? col(porCanal.af7.alpha_pct) : "",
        bandasDisponibles ? col(porCanal.af7.beta_pct) : "",
        bandasDisponibles ? col(porCanal.af8.theta_pct) : "",
        bandasDisponibles ? col(porCanal.af8.alpha_pct) : "",
        bandasDisponibles ? col(porCanal.af8.beta_pct) : "",
        bandasDisponibles ? col(porCanal.tp10.theta_pct) : "",
        bandasDisponibles ? col(porCanal.tp10.alpha_pct) : "",
        bandasDisponibles ? col(porCanal.tp10.beta_pct) : "",
        bandaActualizada,
        liveState.accelX.toFixed(3), liveState.accelY.toFixed(3), liveState.accelZ.toFixed(3),
        liveState.gyroX.toFixed(3), liveState.gyroY.toFixed(3), liveState.gyroZ.toFixed(3),
        artefactoMuestra,
        sesionState.currentMarker
    ].join(",");
    sesionState.csvRows.push(row);

    if (sesionState.currentMarker !== "none") sesionState.currentMarker = "none";
}

// Procesa cada muestra que llega ya sincronizada de los 4 canales
function procesarMuestraSincronizada(crudos, timestampMuestra) {
    document.getElementById("tp9").innerText = crudos.tp9.toFixed(2);
    document.getElementById("af7").innerText = crudos.af7.toFixed(2);
    document.getElementById("af8").innerText = crudos.af8.toFixed(2);
    document.getElementById("tp10").innerText = crudos.tp10.toFixed(2);

    // Filtra los 4 canales
    const filtrados = {
        tp9: applyFilters(crudos.tp9, 'tp9'),
        af7: applyFilters(crudos.af7, 'af7'),
        af8: applyFilters(crudos.af8, 'af8'),
        tp10: applyFilters(crudos.tp10, 'tp10'),
    };

    // Mientras calibra solo acumula datos, no guarda ni evalúa nada aún
    if (calibrando) {
        calibracionBuffer.tp9.push(filtrados.tp9);
        calibracionBuffer.af7.push(filtrados.af7);
        calibracionBuffer.af8.push(filtrados.af8);
        calibracionBuffer.tp10.push(filtrados.tp10);
        return;
    }

    eegDataBuffer.tp9.push(filtrados.tp9); eegDataBuffer.tp9.shift();
    eegDataBuffer.af7.push(filtrados.af7); eegDataBuffer.af7.shift();
    eegDataBuffer.af8.push(filtrados.af8); eegDataBuffer.af8.shift();
    eegDataBuffer.tp10.push(filtrados.tp10); eegDataBuffer.tp10.shift();

    refreshEegChart();

    const artefactoMuestra = detectarArtefacto(
        [filtrados.tp9, filtrados.af7, filtrados.af8, filtrados.tp10],
        liveState.accelX, liveState.accelY, liveState.accelZ,
        umbralAmplitudCalibrado
    );
    if (artefactoMuestra === 1) {
        const magAcel = Math.sqrt(liveState.accelX ** 2 + liveState.accelY ** 2 + liveState.accelZ ** 2);
        console.log('ARTEFACTO →', 'ampMax:', Math.max(...Object.values(filtrados).map(Math.abs)).toFixed(1), '| magAcel:', magAcel.toFixed(3));
    }

    guardarFilaCSV(timestampMuestra ?? Date.now(), crudos, filtrados, artefactoMuestra);

    bandBuffers.tp9.push(filtrados.tp9);
    bandBuffers.af7.push(filtrados.af7);
    bandBuffers.af8.push(filtrados.af8);
    bandBuffers.tp10.push(filtrados.tp10);

    // Cuando ya hay 1 segundo de datos, calcula las bandas
    if (bandBuffers.af7.length >= bufferSize) {
        const bandasTP9 = computeBands(bandBuffers.tp9);
        const bandasAF7 = computeBands(bandBuffers.af7);
        const bandasAF8 = computeBands(bandBuffers.af8);
        const bandasTP10 = computeBands(bandBuffers.tp10);

        const thetaProm = (bandasTP9.theta_pct + bandasAF7.theta_pct + bandasAF8.theta_pct + bandasTP10.theta_pct) / 4;
        const alphaProm = (bandasTP9.alpha_pct + bandasAF7.alpha_pct + bandasAF8.alpha_pct + bandasTP10.alpha_pct) / 4;
        const betaProm = (bandasTP9.beta_pct + bandasAF7.beta_pct + bandasAF8.beta_pct + bandasTP10.beta_pct) / 4;

        ultimasBandas = {
            theta: thetaProm, alpha: alphaProm, beta: betaProm,
            porCanal: { tp9: bandasTP9, af7: bandasAF7, af8: bandasAF8, tp10: bandasTP10 }
        };
        bandasDisponibles = true;
        bandaFrescaPendiente = true;

        document.getElementById("theta").innerText = thetaProm.toFixed(2);
        document.getElementById("alpha").innerText = alphaProm.toFixed(2);
        document.getElementById("beta").innerText = betaProm.toFixed(2);

        updateChart(thetaProm, alphaProm, betaProm);

        if (sesionState.recording) {
            sesionState.historialEvolucionBandas.push({
                t: ((Date.now() - liveState.sessionStartTime) / 1000).toFixed(2),
                theta: thetaProm.toFixed(2),
                alpha: alphaProm.toFixed(2),
                beta: betaProm.toFixed(2),
                theta_tp9_abs: bandasTP9.theta_abs.toFixed(4), alpha_tp9_abs: bandasTP9.alpha_abs.toFixed(4), beta_tp9_abs: bandasTP9.beta_abs.toFixed(4),
                theta_af7_abs: bandasAF7.theta_abs.toFixed(4), alpha_af7_abs: bandasAF7.alpha_abs.toFixed(4), beta_af7_abs: bandasAF7.beta_abs.toFixed(4),
                theta_af8_abs: bandasAF8.theta_abs.toFixed(4), alpha_af8_abs: bandasAF8.alpha_abs.toFixed(4), beta_af8_abs: bandasAF8.beta_abs.toFixed(4),
                theta_tp10_abs: bandasTP10.theta_abs.toFixed(4), alpha_tp10_abs: bandasTP10.alpha_abs.toFixed(4), beta_tp10_abs: bandasTP10.beta_abs.toFixed(4)
            });
        }

        // Guarda solo la mitad más reciente del buffer
        bandBuffers.tp9 = bandBuffers.tp9.slice(stepSize);
        bandBuffers.af7 = bandBuffers.af7.slice(stepSize);
        bandBuffers.af8 = bandBuffers.af8.slice(stepSize);
        bandBuffers.tp10 = bandBuffers.tp10.slice(stepSize);
    }
}

// Termina la calibración y habilita los botones de grabación
function finalizarCalibracion() {
    calibracionTimeoutId = null;
    calibrando = false;
    calibracionValida = true;
    umbralAmplitudCalibrado = calcularUmbralAmplitud(calibracionBuffer);
    console.log('Umbral de amplitud calibrado para este sujeto (uV):', umbralAmplitudCalibrado.toFixed(2));

    document.getElementById("startRecording").disabled = false;
    document.getElementById("startTrial").disabled = false;
    showStatusMessage("Calibración lista, ya puedes iniciar la grabación", "#2ecc71");
}

// Conecta los canales de datos del Muse: EEG, acelerómetro, giroscopio y batería
function suscribirCanales() {
    suscripcionesCanal.forEach(s => { try { s.unsubscribe(); } catch (e) { /* ya estaba cerrada */ } });
    suscripcionesCanal = [];

    // Une los 4 electrodos en una sola muestra por timestamp
    const subEEG = zipSamples(client.eegReadings).subscribe(sample => {
        const crudos = {
            tp9: sample.data[0],
            af7: sample.data[1],
            af8: sample.data[2],
            tp10: sample.data[3],
        };
        procesarMuestraSincronizada(crudos, sample.timestamp);
    });
    suscripcionesCanal.push(subEEG);

    // Acelerómetro
    const subAccel = client.accelerometerData.subscribe(reading => {
        const ultima = reading.samples[reading.samples.length - 1];
        liveState.accelX = ultima.x; liveState.accelY = ultima.y; liveState.accelZ = ultima.z;
        document.getElementById("accelX").innerText = liveState.accelX.toFixed(2);
        document.getElementById("accelY").innerText = liveState.accelY.toFixed(2);
        document.getElementById("accelZ").innerText = liveState.accelZ.toFixed(2);
    });
    suscripcionesCanal.push(subAccel);

    // Giroscopio
    const subGyro = client.gyroscopeData.subscribe(reading => {
        const ultima = reading.samples[reading.samples.length - 1];
        liveState.gyroX = ultima.x; liveState.gyroY = ultima.y; liveState.gyroZ = ultima.z;
        const elX = document.getElementById("gyroX");
        const elY = document.getElementById("gyroY");
        const elZ = document.getElementById("gyroZ");
        if (elX) elX.innerText = liveState.gyroX.toFixed(2);
        if (elY) elY.innerText = liveState.gyroY.toFixed(2);
        if (elZ) elZ.innerText = liveState.gyroZ.toFixed(2);
    });
    suscripcionesCanal.push(subGyro);

    // Batería
    const subBateria = client.telemetryData.subscribe(t => {
        const el = document.getElementById("battery");
        if (el && t.batteryLevel != null) el.innerText = Math.min(t.batteryLevel, 100);
    });
    suscripcionesCanal.push(subBateria);
}

// Reintenta reconectar al mismo dispositivo sin pedirle nada al usuario
async function intentarReconexionAutomatica() {
    if (reconectando) return;
    if (!museDevice) return;
    reconectando = true;

    for (let intento = 1; intento <= MAX_INTENTOS_RECONEXION; intento++) {
        await new Promise(resolve => setTimeout(resolve, INTERVALO_RECONEXION_MS));

        if (desconexionManual) { reconectando = false; return; } // se desconectó a propósito, se cancela

        try {
            showStatusMessage(`Reconectando automáticamente… (intento ${intento}/${MAX_INTENTOS_RECONEXION})`, "#ff9800");
            const gatt = await museDevice.gatt.connect();
            await client.connect(gatt);
            await client.start();
            suscribirCanales();

            // Limpia filtros y buffers para no mezclar señal de antes del corte
            resetearFiltros();
            bandBuffers = { tp9: [], af7: [], af8: [], tp10: [] };
            bandaFrescaPendiente = false;

            if (calibrando) {
                // Si se cortó a mitad de la calibración, se reinicia desde cero
                calibracionBuffer = { tp9: [], af7: [], af8: [], tp10: [] };
                if (calibracionTimeoutId) clearTimeout(calibracionTimeoutId);
                calibracionTimeoutId = setTimeout(finalizarCalibracion, DURACION_CALIBRACION_MS);
                showStatusMessage("Señal recuperada durante la calibración: se reinician los 30s en reposo", "#ff9800");
            }

            const elDeviceStatus = document.getElementById("device-status");
            if (elDeviceStatus) {
                elDeviceStatus.innerHTML = '<i class="ri-circle-fill me-1" style="font-size:8px;"></i>Conectado';
                elDeviceStatus.className = "fw-bold text-success";
            }

            if (sesionState.recording && typeof sesionState.agregarMarcadorLibre === 'function') {
                sesionState.agregarMarcadorLibre("SEÑAL_RECUPERADA");
            }
            showStatusMessage("✅ Señal recuperada automáticamente, la sesión continúa", "#2ecc71");

            reconectando = false;
            return true;
        } catch (e) {
            console.warn(`Intento de reconexión automática ${intento} falló:`, e);
        }
    }

    // Se agotaron los intentos, se avisa al usuario según el caso
    reconectando = false;
    if (sesionState.recording) {
        const seCerroUnaPruebaEnCurso = typeof sesionState.interrumpirPruebaActual === 'function'
            && sesionState.interrumpirPruebaActual();
        if (!seCerroUnaPruebaEnCurso && typeof sesionState.marcarInterrupcionSenal === 'function') {
            sesionState.marcarInterrupcionSenal();
        }
        showStatusMessage("⚠️ No se pudo reconectar automáticamente. Los datos grabados hasta ahora están a salvo — presiona Conectar para continuar manualmente.", "#e74c3c");
    } else if (calibrando) {
        showStatusMessage("⚠️ Se perdió la señal durante la calibración. Presiona Conectar para reintentar la calibración desde cero.", "#e74c3c");
    } else {
        showStatusMessage("⚠️ No se pudo reconectar automáticamente. Presiona Conectar para intentarlo de nuevo.", "#e74c3c");
    }
    return false;
}

// Verifica si el navegador soporta y tiene habilitada la API Web Bluetooth
export function verificarSoporteBluetooth() {
    if (!navigator.bluetooth || typeof navigator.bluetooth.requestDevice !== 'function') {
        if (!window.isSecureContext) {
            return {
                soportado: false,
                mensaje: "Web Bluetooth requiere un contexto seguro (HTTPS o http://localhost)."
            };
        }
        const ua = navigator.userAgent || "";
        if (navigator.brave || ua.includes("Brave")) {
            return {
                soportado: false,
                mensaje: "Brave bloquea Web Bluetooth por defecto. Habilítalo en brave://settings/content/bluetoothDevices o en brave://flags/#enable-web-bluetooth"
            };
        }
        if (ua.includes("Firefox")) {
            return {
                soportado: false,
                mensaje: "Firefox no soporta la API Web Bluetooth. Utiliza Google Chrome, Microsoft Edge o Chromium."
            };
        }
        if (ua.includes("Linux") && (ua.includes("Chrome") || ua.includes("Chromium"))) {
            return {
                soportado: false,
                mensaje: "En Chrome para Linux, Web Bluetooth viene desactivado por defecto. Abre una pestaña en chrome://flags/#enable-web-bluetooth, cámbialo a 'Enabled' y reinicia Chrome."
            };
        }
        return {
            soportado: false,
            mensaje: "Tu navegador no tiene disponible la API Web Bluetooth. Asegúrate de usar Chrome/Edge y activar la flag chrome://flags/#enable-web-bluetooth si estás en Linux."
        };
    }
    return { soportado: true };
}

// Botón "Conectar": vincula el dispositivo y arranca la grabación de datos
document.getElementById("connect").onclick = async () => {
    const soporte = verificarSoporteBluetooth();
    if (!soporte.soportado) {
        console.error("Web Bluetooth no disponible:", soporte.mensaje);
        showStatusMessage(soporte.mensaje, "#d90429");
        alert("⚠️ " + soporte.mensaje);
        return;
    }

    try {
        detenerAdquisicion();
        desconexionManual = false;
        resetearFiltros();
        bandasDisponibles = false;
        bandaFrescaPendiente = false;
        bandBuffers = { tp9: [], af7: [], af8: [], tp10: [] };

        liveState.chartStartTime = Date.now();
        resetChartData();

        client = new MuseClient();
        await client.connect();
        museDevice = client.gatt ? client.gatt.device : null;

        // Avisa cuando la conexión se cae
        subConexionRef = client.connectionStatus.subscribe(conectado => {
            const elDeviceStatus = document.getElementById("device-status");
            if (conectado) {
                if (elDeviceStatus) {
                    elDeviceStatus.innerHTML = '<i class="ri-circle-fill me-1" style="font-size:8px;"></i>Conectado';
                    elDeviceStatus.className = "fw-bold text-success";
                }
                return;
            }

            if (elDeviceStatus) {
                elDeviceStatus.innerHTML = '<i class="ri-circle-fill me-1" style="font-size:8px;"></i>Sin señal';
                elDeviceStatus.className = "fw-bold text-danger";
            }

            if (desconexionManual) return;

            if (calibrando && calibracionTimeoutId) {
                clearTimeout(calibracionTimeoutId);
                calibracionTimeoutId = null;
            }

            sesionState.huboInterrupcionConexion = true;

            if (sesionState.recording) {
                // No se cierra la prueba, solo se deja marcado y se intenta reconectar
                if (typeof sesionState.agregarMarcadorLibre === 'function') {
                    sesionState.agregarMarcadorLibre("SEÑAL_PERDIDA_EN_CURSO");
                }
                showStatusMessage("⚠️ Se perdió la señal. Intentando reconectar automáticamente…", "#e74c3c");
            } else {
                showStatusMessage("⚠️ Se perdió la señal del dispositivo. Intentando reconectar…", "#e74c3c");
            }

            intentarReconexionAutomatica();
        });

        if (!scene) { scene = true; initThreeJS(); }
        initChart();
        initEEGChart();

        await client.start();
        suscribirCanales();

        if (calibracionValida) {
            // Ya se calibró antes, se reutiliza ese umbral
            calibrando = false;
            showStatusMessage("Dispositivo reconectado. Continuando con el umbral ya calibrado.", "#2ecc71");
            document.getElementById("startRecording").disabled = false;
            document.getElementById("startTrial").disabled = false;
        } else {
            // Primera vez en esta sesión, hay que calibrar
            calibrando = true;
            calibracionBuffer = { tp9: [], af7: [], af8: [], tp10: [] };
            umbralAmplitudCalibrado = null;
            showStatusMessage("Dispositivo conectado correctamente, calibrando 30s en reposo...");
            document.getElementById("startRecording").disabled = true;
            document.getElementById("startTrial").disabled = true;

            if (calibracionTimeoutId) clearTimeout(calibracionTimeoutId);
            calibracionTimeoutId = setTimeout(finalizarCalibracion, DURACION_CALIBRACION_MS);
        }

    } catch (e) {
        console.error("Error en conexión Muse:", e);
        if (e.name === 'NotFoundError' || (e.message && e.message.includes('User cancelled'))) {
            showStatusMessage("Vinculación cancelada o dispositivo no seleccionado", "#ff9800");
        } else if (e.name === 'SecurityError') {
            showStatusMessage("Permiso de Bluetooth denegado por el navegador", "#d90429");
        } else {
            showStatusMessage("Error de conexión, vuelve a vincular el dispositivo", "#d90429");
        }
    }
};

// Botón "Desconectar": corta todo y obliga a recalibrar la próxima vez
document.getElementById("disconnect").onclick = () => {
    desconexionManual = true;
    calibracionValida = false;
    museDevice = null;
    detenerAdquisicion();
    window.location.reload();
};