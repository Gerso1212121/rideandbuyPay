require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ CONFIGURACIÓN CORREGIDA PARA EL SALVADOR
const WOMPI_API_URL = process.env.WOMPI_API || 'https://api.wompi.sv/v1/';
const WOMPI_AUTH_URL = process.env.WOMPI_AUTH || 'https://id.wompi.sv/';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://chavarria-web-1.onrender.com/webhook/wompi';

// Límites en dólares
const MONTO_MAXIMO = 100000; // $1000 USD en centavos
const MONTO_MINIMO = 100;    // $1 USD en centavos

const transacciones = new Map();

// Endpoint de debug para verificar configuración
app.get('/api/debug/wompi-config', (req, res) => {
    res.json({
        WOMPI_CLIENT_ID: process.env.WOMPI_CLIENT_ID ? 'CONFIGURADO' : 'FALTANTE',
        WOMPI_CLIENT_SECRET: process.env.WOMPI_CLIENT_SECRET ? 'CONFIGURADO' : 'FALTANTE',
        WOMPI_API: WOMPI_API_URL,
        WOMPI_AUTH: WOMPI_AUTH_URL,
        WEBHOOK_URL: WEBHOOK_URL,
        MONTO_MAXIMO: `${MONTO_MAXIMO / 100} USD`,
        MONTO_MINIMO: `${MONTO_MINIMO / 100} USD`
    });
});

// 1. Generar enlace de pago (VERSIÓN CORREGIDA)
app.post('/api/wompi/generar-enlace-renta', async (req, res) => {
    try {
        const { referencia, montoCents, descripcion, clienteId } = req.body;

        console.log('🚗 Generando enlace de pago:', { referencia, montoCents });

        // ✅ VERIFICAR CREDENCIALES
        if (!process.env.WOMPI_CLIENT_ID || !process.env.WOMPI_CLIENT_SECRET) {
            console.error('❌ Credenciales Wompi faltantes');
            return res.status(500).json({ 
                ok: false, 
                error: 'Configuración incompleta del servicio de pagos' 
            });
        }

        // Validar monto
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

        console.log('🔑 Obteniendo token de Wompi...');
        
        // Obtener token de Wompi (CORREGIDO)
        const tokenResp = await axios.post(
            WOMPI_AUTH_URL + 'connect/token',
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: process.env.WOMPI_CLIENT_ID,
                client_secret: process.env.WOMPI_CLIENT_SECRET,
                audience: 'wompi_api',
            }).toString(),
            { 
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 10000
            }
        );

        if (!tokenResp.data.access_token) {
            throw new Error('No se pudo obtener token de acceso');
        }

        const token = tokenResp.data.access_token;
        console.log('✅ Token obtenido correctamente');

        // ✅ PAYLOAD CORREGIDO para Wompi El Salvador
        const payload = {
            name: descripcion || "Renta de Vehículo",
            description: `Renta - ${clienteId || 'Cliente'}`,
            single_use: true,
            collect_shipping: false,
            currency: "USD",
            amount_in_cents: montoCents, // ✅ ENVÍADO EN CENTAVOS
            redirect_url: `${process.env.FRONTEND_URL || 'https://tu-app.com'}/renta/resultado?referencia=${referencia}`,
            reference: referencia,
        };

        console.log('📤 Enviando a Wompi SV:', {
            url: WOMPI_API_URL + 'payment_links',
            payload: payload
        });

        // Crear enlace en Wompi (CORREGIDO)
        const wompiResp = await axios.post(
            WOMPI_API_URL + 'payment_links', // ✅ ENDPOINT CORRECTO
            payload, 
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 15000
            }
        );

        console.log('✅ Respuesta de Wompi SV:', wompiResp.data);

        // Guardar transacción
        transacciones.set(referencia, {
            montoCents,
            clienteId,
            descripcion,
            estado: 'pendiente',
            fecha: new Date(),
            idEnlace: wompiResp.data.data?.id,
            moneda: "USD",
            urlEnlace: wompiResp.data.data?.checkout_url
        });

        res.json({
            ok: true,
            urlEnlace: wompiResp.data.data?.checkout_url,
            idEnlace: wompiResp.data.data?.id,
            referencia: referencia,
        });

    } catch (err) {
        console.error('❌ Error generando enlace:', {
            message: err.message,
            response: err.response?.data,
            status: err.response?.status
        });
        
        let errorMessage = 'Error al generar enlace de pago';
        if (err.response?.data) {
            errorMessage = err.response.data.error?.message || 
                          err.response.data.mensajes?.[0] || 
                          JSON.stringify(err.response.data);
        }

        res.status(500).json({ 
            ok: false, 
            error: errorMessage,
            detalles: err.response?.data
        });
    }
});

// 2. Webhook (MANTIENE LA MISMA ESTRUCTURA)
app.post('/webhook/wompi', async (req, res) => {
    console.log('📥 Webhook recibido de Wompi:', JSON.stringify(req.body, null, 2));
    
    const event = req.body?.event || req.body?.Evento;
    const data = req.body?.data || req.body?.Datos;
    const reference = data?.reference || data?.IdentificadorEnlaceComercio;

    if (!reference) {
        console.warn('⚠️ Webhook sin referencia válida');
        return res.status(400).json({ error: 'Referencia faltante' });
    }

    try {
        const transaccion = transacciones.get(reference);
        
        if (!transaccion) {
            console.warn('⚠️ Transacción no encontrada:', reference);
            return res.status(404).json({ error: 'Transacción no encontrada' });
        }

        // Procesar según el evento
        switch (event) {
            case 'transaction.approved':
            case 'TransaccionAprobada':
                transaccion.estado = 'aprobado';
                transaccion.fechaAprobacion = new Date();
                transaccion.idTransaccion = data?.id || data?.IdTransaccion;
                console.log('✅ Pago APROBADO:', reference);
                break;

            case 'transaction.declined':
            case 'TransaccionDeclinada':
                transaccion.estado = 'rechazado';
                transaccion.razon = data?.reason || data?.Razon;
                console.log('❌ Pago RECHAZADO:', reference);
                break;

            case 'transaction.failed':
            case 'TransaccionFallida':
                transaccion.estado = 'fallido';
                transaccion.error = data?.error || data?.Error;
                console.log('💥 Pago FALLIDO:', reference);
                break;

            default:
                console.log('ℹ️ Evento no manejado:', event);
        }

        transacciones.set(reference, transaccion);
        res.json({ ok: true, mensaje: 'Webhook procesado' });

    } catch (error) {
        console.error('❌ Error procesando webhook:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// 3. Endpoint para consultar estado
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
        moneda: transaccion.moneda
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        ok: true, 
        message: 'Servidor de pagos funcionando',
        transaccionesActivas: transacciones.size,
        moneda: 'USD',
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de pagos corriendo en puerto ${PORT}`);
    console.log(`🔧 Entorno: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💰 Moneda: USD`);
    console.log(`🔗 Webhook: ${WEBHOOK_URL}`);
    console.log(`🌐 Wompi API: ${WOMPI_API_URL}`);
});