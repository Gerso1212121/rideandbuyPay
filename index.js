require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ CONFIGURADO PARA USD: Límites en dólares
const MONTO_MAXIMO = 100000; // $1000 USD en centavos (1000 * 100)
const MONTO_MINIMO = 100;    // $1 USD en centavos

// Almacenamiento en memoria
const transacciones = new Map();

// 1. Generar enlace de pago
app.post('/api/wompi/generar-enlace-renta', async (req, res) => {
    try {
        const { referencia, montoCents, descripcion, clienteId } = req.body;

        console.log('🚗 Generando enlace de pago:', { referencia, montoCents });

        // ✅ VALIDACIONES PARA USD
        if (montoCents > MONTO_MAXIMO) {
            return res.status(400).json({
                ok: false,
                error: `Monto máximo permitido es $${MONTO_MAXIMO / 100} USD. Tu monto: $${(montoCents / 100).toFixed(2)} USD`
            });
        }

        if (montoCents < MONTO_MINIMO) {
            return res.status(400).json({
                ok: false,
                error: `Monto mínimo permitido es $${MONTO_MINIMO / 100} USD`
            });
        }

        // Obtener token de Wompi
        const tokenResp = await axios.post(
            (process.env.WOMPI_AUTH || 'https://id.wompi.dev/') + 'connect/token',
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

        // ✅ CONFIGURADO PARA USD: Moneda USD en el payload
        const payload = {
            identificadorEnlaceComercio: referencia,
            monto: montoCents,
            nombreProducto: descripcion || "Renta de Vehículo",
            moneda: "USD", // ✅ CAMBIADO A USD
            configuracion: {
                duracionInterfazIntentoMinutos: 30,
                urlWebhook: `${process.env.BACKEND_URL || 'https://rideandbuypay.onrender.com'}/webhook/wompi`,
                urlRedirect: `${process.env.FRONTEND_URL || 'https://tu-app.com'}/renta/resultado?referencia=${referencia}`,
            },
        };

        console.log('📤 Enviando a Wompi:', payload);

        // Crear enlace en Wompi
        const wompiResp = await axios.post(
            (process.env.WOMPI_API || 'https://api.wompi.dev/') + 'EnlacePago', 
            payload, 
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        console.log('✅ Respuesta de Wompi:', wompiResp.data);

        // Guardar transacción en memoria
        transacciones.set(referencia, {
            montoCents,
            clienteId,
            descripcion,
            estado: 'pendiente',
            fecha: new Date(),
            idEnlace: wompiResp.data.idEnlace,
            moneda: "USD" // ✅ CAMBIADO A USD
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
        
        let errorMessage = 'Error al generar enlace de pago';
        if (err.response?.data) {
            errorMessage = err.response.data.mensajes?.[0] || JSON.stringify(err.response.data);
        } else if (err.message) {
            errorMessage = err.message;
        }

        res.status(500).json({ 
            ok: false, 
            error: errorMessage,
            detalles: err.response?.data
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
                transaccion.idTransaccion = datos?.IdTransaccion;
                console.log('✅ Pago APROBADO:', referencia, 'ID:', datos?.IdTransaccion);
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
        fecha: transaccion.fecha,
        idTransaccion: transaccion.idTransaccion,
        moneda: transaccion.moneda // ✅ Incluir moneda en la respuesta
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        ok: true, 
        message: 'Servidor de pagos funcionando',
        transaccionesActivas: transacciones.size,
        moneda: 'USD', // ✅ Especificar moneda
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de pagos corriendo en puerto ${PORT}`);
    console.log(`🔧 Entorno: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💰 Moneda: USD`);
    console.log(`💰 Límite máximo por transacción: $${MONTO_MAXIMO / 100} USD`);
    console.log(`💰 Límite mínimo por transacción: $${MONTO_MINIMO / 100} USD`);
});