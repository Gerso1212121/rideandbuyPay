require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');

const app = express();

// Middleware
app.use(compression());
app.use(cors({ origin: '*' }));
app.use(express.json());

const MONTO_MAXIMO = 60000; // $600 USD en centavos

// Almacenamiento en memoria (puedes usar Redis en producción)
const transacciones = new Map();

// 1. Generar enlace de pago
app.post('/api/wompi/generar-enlace-renta', async (req, res) => {
    try {
        const { referencia, montoCents, descripcion, clienteId } = req.body;

        console.log('🚗 Generando enlace de pago:', { referencia, montoCents });

        // Validar monto máximo
        if (montoCents > MONTO_MAXIMO) {
            return res.status(400).json({
                ok: false,
                error: `Monto máximo permitido es $${MONTO_MAXIMO / 100} USD`
            });
        }

        // Obtener token de Wompi
        const tokenResp = await axios.post(
            process.env.WOMPI_AUTH + 'connect/token',
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.WOMPI_CLIENT_ID,
                client_secret: process.env.WOMPI_CLIENT_SECRET,
                audience: 'wompi_api',
            }).toString(),
            { 
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
            }
        );

        const token = tokenResp.data.access_token;

        // Crear payload para Wompi
        const payload = {
            identificadorEnlaceComercio: referencia,
            monto: montoCents,
            nombreProducto: descripcion || "Renta de Vehículo",
            configuracion: {
                duracionInterfazIntentoMinutos: 30,
                urlWebhook: `${process.env.BACKEND_URL}/webhook/wompi`, // 👈 Wompi llamará aquí
                urlRedirect: `${process.env.FRONTEND_URL}/renta/resultado?referencia=${referencia}`,
            },
        };

        // Crear enlace en Wompi
        const wompiResp = await axios.post(
            process.env.WOMPI_API + 'EnlacePago', 
            payload, 
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        // Guardar transacción en memoria
        transacciones.set(referencia, {
            montoCents,
            clienteId,
            descripcion,
            estado: 'pendiente',
            fecha: new Date(),
            idEnlace: wompiResp.data.idEnlace
        });

        console.log('✅ Enlace generado para:', referencia);

        res.json({
            ok: true,
            urlEnlace: wompiResp.data.urlEnlace,
            idEnlace: wompiResp.data.idEnlace,
            referencia: referencia,
        });

    } catch (err) {
        console.error('❌ Error generando enlace:', err.response?.data || err.message);
        res.status(500).json({ 
            ok: false, 
            error: 'Error al generar enlace de pago'
        });
    }
});

// 2. Webhook que Wompi llama automáticamente
app.post('/webhook/wompi', async (req, res) => {
    console.log('📥 Webhook recibido de Wompi:', JSON.stringify(req.body, null, 2));

    const evento = req.body?.Evento;
    const datos = req.body?.Datos;
    const referencia = datos?.IdentificadorEnlaceComercio;

    if (!referencia) {
        console.warn('⚠️ Webhook sin referencia válida');
        return res.status(400).json({ error: 'Referencia faltante' });
    }

    try {
        const transaccion = transacciones.get(referencia);
        
        if (!transaccion) {
            console.warn('⚠️ Transacción no encontrada:', referencia);
            return res.status(404).json({ error: 'Transacción no encontrada' });
        }

        // Procesar según el evento
        switch (evento) {
            case 'TransaccionAprobada':
                transaccion.estado = 'aprobado';
                transaccion.fechaAprobacion = new Date();
                console.log('✅ Pago APROBADO:', referencia);
                
                // Aquí puedes: 
                // - Activar la renta
                // - Enviar email de confirmación
                // - Notificar a Flutter vía WebSockets
                break;

            case 'TransaccionDeclinada':
                transaccion.estado = 'rechazado';
                transaccion.razon = datos?.Razon;
                console.log('❌ Pago RECHAZADO:', referencia, datos?.Razon);
                break;

            case 'TransaccionFallida':
                transaccion.estado = 'fallido';
                transaccion.error = datos?.Error;
                console.log('💥 Pago FALLIDO:', referencia, datos?.Error);
                break;

            default:
                console.log('ℹ️ Evento no manejado:', evento);
        }

        // Actualizar transacción
        transacciones.set(referencia, transaccion);

        // Responder a Wompi que recibimos el webhook
        res.json({ ok: true, mensaje: 'Webhook procesado' });

    } catch (error) {
        console.error('❌ Error procesando webhook:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// 3. Endpoint para consultar estado (Flutter puede preguntar)
app.get('/api/wompi/estado/:referencia', (req, res) => {
    const { referencia } = req.params;
    const transaccion = transacciones.get(referencia);

    if (!transaccion) {
        return res.status(404).json({ ok: false, error: 'Transacción no encontrada' });
    }

    res.json({
        ok: true,
        referencia,
        estado: transaccion.estado,
        montoCents: transaccion.montoCents,
        fecha: transaccion.fecha
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        ok: true, 
        message: 'Servidor de pagos funcionando',
        transaccionesActivas: transacciones.size
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de pagos corriendo en puerto ${PORT}`);
});