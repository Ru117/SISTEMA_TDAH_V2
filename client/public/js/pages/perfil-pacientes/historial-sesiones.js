let sesionEnEdicionPronostico = null;

function pintarBadgeDiagnostico(span, diagnostico) {
    span.textContent = diagnostico || 'Sin diagnóstico';
    span.className = 'badge campo-badge-diagnostico'; // reset de clases previas
    if (diagnostico === 'TDAH Combinado') {
        span.classList.add('bg-danger-subtle', 'text-danger');
    } else if (diagnostico === 'Sin TDAH') {
        span.classList.add('bg-success-subtle', 'text-success');
    } else if (diagnostico === 'TDAH Inatento') {
        span.classList.add('bg-secondary-subtle', 'text-warning');
    } else if (diagnostico === 'TDAH Hiperactivo') {
        span.classList.add('bg-secondary-subtle', 'text-danger');
    } else {
        span.classList.add('bg-secondary-subtle', 'text-secondary');
    }
}

async function cargarHistorialSesiones() {
    try {
        const res = await fetch(`/api/historial-paciente/${id}`);
        cacheSesiones = await res.json();
        const tbody = document.getElementById('tablaSesionesBody');
        tbody.innerHTML = '';

        if (cacheSesiones.length === 0) {
            const vacio = document.getElementById('tplFilaSesionVacia').content.cloneNode(true);
            tbody.appendChild(vacio);
            return;
        }

        cacheSesiones.forEach((s, i) => {
            const fila = document.getElementById('tplFilaSesion').content.cloneNode(true);

            const f = new Date(s.fecha_hora);
            const fecha = f.toLocaleDateString() + ' ' + f.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const segundos = Math.round(s.duracion_total_seg);
            const nombreEquipo = s.nombre_dispositivo || "No registrado";

            fila.querySelector('.campo-id').textContent = `#${s.id_sesion}`;
            fila.querySelector('.campo-fecha').textContent = fecha;
            fila.querySelector('.campo-dispositivo').textContent = nombreEquipo;
            fila.querySelector('.campo-duracion').textContent = `${segundos} seg`;
            fila.querySelector('.campo-total-pruebas').textContent = `${s.total_pruebas} pruebas`;

            // Si nunca se ha hecho un pronóstico, s.diagnostico debe llegar
            // como "Sin diagnóstico" (así lo guarda el backend por defecto)
            pintarBadgeDiagnostico(fila.querySelector('.campo-badge-diagnostico'), s.diagnostico);

            fila.querySelector('.campo-probabilidad').textContent = (s.probability * 100).toFixed(2) + "%";

            fila.querySelector('.btn-ver-resumen').addEventListener('click', () => verResumen(i));
            fila.querySelector('.btn-eliminar-sesion').addEventListener('click', () => confirmarEliminarSesion(s.id_sesion));
            fila.querySelector('.btn-realizar-pronostico').addEventListener('click', () => abrirModalPronostico(s));

            const btnReanudar = fila.querySelector('.btn-reanudar-sesion');
            revisarSiFaltanPruebas(s.id_sesion, s.dispositivo_id, btnReanudar);

            tbody.appendChild(fila);
        });

    } catch (e) {
        console.error("Error historial:", e);
    }
}

// Consulta al backend si a esta sesión le faltan pruebas por hacer, y si es
// así, muestra el botón de reanudar ya listo para llevar al usuario a
// iniciarSesion.html con solo las pruebas pendientes
async function revisarSiFaltanPruebas(idSesion, dispositivoId, btnReanudar) {
    if (!btnReanudar) return;
    try {
        const res = await fetch(`/api/sesiones/${idSesion}/pruebas-faltantes`);
        const data = await res.json();
        if (data.completa || !data.pruebasFaltantes?.length) return;

        const idsFaltantes = data.pruebasFaltantes.map(p => p.id).join(',');
        btnReanudar.classList.remove('invisible');
        btnReanudar.title = `Reanudar sesión (faltan: ${data.pruebasFaltantes.map(p => p.nombre).join(', ')})`;
        btnReanudar.addEventListener('click', () => {
            const dev = dispositivoId ? `&dev=${dispositivoId}` : '';
            window.location.href = `/iniciarSesion.html?id=${id}${dev}&pruebas=${idsFaltantes}&sesion=${idSesion}`;
        });
    } catch (e) {
        console.error("Error revisando pruebas faltantes:", e);
    }
}

// Abre el modal de pronóstico precargado con el valor actual de la sesión
// (si ya tenía uno) y deja marcada esa sesión como la que se va a editar
function abrirModalPronostico(sesion) {
    sesionEnEdicionPronostico = sesion;
    document.getElementById('idSesionPronostico').textContent = `#${sesion.id_sesion}`;
    const testText = document.createElement("h6");
    testText.textContent = "Pruebas realizadas:";
    document.getElementById('idSesionPronostico').appendChild(testText);
    if ("detalles_pruebas" in sesion) {
        for (const prueba of sesion.detalles_pruebas) {
            const p_prueba = document.createElement("p");
            p_prueba.textContent = prueba.nombre;
            document.getElementById('idSesionPronostico').appendChild(
                p_prueba
            );
        }
    }
    const checkSinTDAH = document.getElementById('checkSinTDAH');
    const checkTDAHDetectado = document.getElementById('checkTDAHDetectado');
    //checkSinTDAH.checked = sesion.diagnostico === 'Sin TDAH';
    //checkTDAHDetectado.checked = sesion.diagnostico === 'TDAH Detectado';

    const modal = new bootstrap.Modal(document.getElementById('modalPronostico'));
    modal.show();
}

// Los dos checkboxes del modal son mutuamente excluyentes: solo uno de los
// dos puede quedar marcado (no puede ser "Sin TDAH" y "TDAH Detectado" a
// la vez). Si no se marca ninguno, al guardar queda "Sin diagnóstico"
document.getElementById('checkSinTDAH').addEventListener('change', function () {
    if (this.checked) document.getElementById('checkTDAHDetectado').checked = false;
});
document.getElementById('checkTDAHDetectado').addEventListener('change', function () {
    if (this.checked) document.getElementById('checkSinTDAH').checked = false;
});

document.getElementById('btnGuardarPronostico').addEventListener('click', async () => {
    if (!sesionEnEdicionPronostico) return;

    const checkSinTDAH = document.getElementById('checkSinTDAH').checked;
    const checkTDAHDetectado = document.getElementById('checkTDAHDetectado').checked;

    // Si no se marcó ningún checkbox, el pronóstico vuelve a "Sin diagnóstico"
    let diagnostico = 'Sin diagnóstico';
    if (checkSinTDAH) diagnostico = 'Sin TDAH';
    else if (checkTDAHDetectado) diagnostico = 'TDAH Detectado';

    const data = await guardarDiagnosticoSesion(sesionEnEdicionPronostico, diagnostico);

    diagnostico = data.clase;

    // Refresca el badge de esa fila sin recargar toda la tabla
    const fila = [...document.querySelectorAll('#tablaSesionesBody tr')]
        .find(tr => tr.querySelector('.campo-id')?.textContent === `#${sesionEnEdicionPronostico.id_sesion}`);
    if (fila) pintarBadgeDiagnostico(fila.querySelector('.campo-badge-diagnostico'), diagnostico);
    if (fila) fila.querySelector('.campo-probabilidad').textContent = (data.prob * 100).toFixed(2) + "%";

    bootstrap.Modal.getInstance(document.getElementById('modalPronostico')).hide();
    sesionEnEdicionPronostico = null;
});

// Guarda el diagnóstico de una sesión específica (lo pone el médico a mano
// por ahora) No recarga toda la tabla, solo avisa si algo falló
async function guardarDiagnosticoSesion(sesion, diagnostico) {
    try {
        const res = await fetch(`/api/sesiones/${sesion.id_sesion}/diagnostico`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ diagnostico })
        });
        const data = await res.json();
        Swal.fire({
            title: data.success ? "Predicción generada correctamente" : "Error al generar la predicción",
            icon: data.success ? "success" : "error",
            showConfirmButton: false,
            timer: 2000,
            text: data.success ? `La probabilidad de tener ${data.clase} es del ${(data.prob * 100).toFixed(2)}%` : data.error || "Error desconocido"
        });
        bootstrap.Modal.getInstance(document.getElementById('modalPronostico')).hide();

        if (!data.success) {
            //alert('No se pudo guardar el diagnóstico: ' + (data.error || 'error desconocido'));
            return;
        }

        // Sincroniza la caché en memoria con lo que ya quedó guardado en la BD
        sesion.diagnostico = diagnostico;

        // Refrescamos el resumen de "último resultado" del paciente,
        // por si esta era su sesión más reciente
        obtenerUltimoResultadoIA();
        return data;
    } catch (e) {
        console.error("Error al guardar diagnóstico:", e);
        alert('Error de conexión al guardar el diagnóstico.');
    }
}

async function confirmarEliminarSesion(idSesion) {
    if (!confirm('¿Estás segura de que deseas eliminar esta sesión?')) return;

    try {
        const res = await fetch(`/api/sesiones/${idSesion}`, {
            method: 'DELETE'
        });
        const data = await res.json();

        if (data.success) {
            cargarHistorialSesiones();
            console.log("Sesión #" + idSesion + " eliminada.");
        } else {
            console.error("Error al borrar:", data.error);
        }
    } catch (e) {
        console.error("Error de conexión:", e);
    }
}

async function obtenerUltimoResultadoIA() {
    try {
        if (!id) return;

        const respuesta = await fetch(`/api/ultimo-resultado/${id}`);
        const data = await respuesta.json();

        if (data && data.diagnostico) {
            $('#resSimple').text(data.diagnostico);

            if (data.diagnostico === "TDAH Detectado") {
                $('#resSimple').css('color', '#e74c3c').css('font-weight', 'bold');
            } else {
                $('#resSimple').css('color', '#2bb2ba').css('font-weight', 'bold');
            }
        } else {
            $('#resSimple').text('Sin sesiones registradas');
        }
    } catch (error) {
        console.error("Error al cargar diagnóstico:", error);
        $('#resSimple').text('Error de conexión');
    }
}