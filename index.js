require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ USA TUS URLs REALES
const WOMPI_API_URL = process.env.WOMPI_API || 'https://api.wompi.sv/v1/';
const WOMPI_AUTH_URL = process.env.WOMPI_AUTH || 'https://id.wompi.sv/';
const WEBHOOK_URL = 'https://rideandbuypay.onrender.com/webhook/wompi'; // ✅ TU WEBHOOK REAL
const REDIRECT_BASE_URL = 'https://rideandbuypay.onrender.com'; // ✅ TU BACKEND REAL

// Límites en dólares
const MONTO_MAXIMO = 100000;
const MONTO_MINIMO = 100;

const transacciones = new Map();

// Endpoint de debug
app.get('/api/debug/wompi-config', (req, res) => {
    const clientId = process.env.WOMPI_CLIENT_ID;
    const clientSecret = process.env.WOMPI_CLIENT_SECRET;
    
    res.json({
        WOMPI_CLIENT_ID: clientId ? `${clientId.substring(0, 8)}...` : 'FALTANTE',
        WOMPI_CLIENT_SECRET: clientSecret ? `${clientSecret.substring(0, 8)}...` : 'FALTANTE',
        WOMPI_API: WOMPI_API_URL,
        WOMPI_AUTH: WOMPI_AUTH_URL,
        WEBHOOK_URL: WEBHOOK_URL,
        REDIRECT_BASE_URL: REDIRECT_BASE_URL,
        MONTO_MAXIMO: `${MONTO_MAXIMO / 100} USD`,
        MONTO_MINIMO: `${MONTO_MINIMO / 100} USD`,
        configuracionCorrecta: !!(clientId && clientSecret)
    });
});

// 1. Generar enlace de pago - CON TUS URLs REALES
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
                error: `Monto máximo permitido es $${MONTO_MAXIMO / 100} USD`
            });
        }

        if (montoCents < MONTO_MINIMO) {
            return res.status(400).json({
                ok: false,
                error: `Monto mínimo permitido es $${MONTO_MINIMO / 100} USD`
            });
        }

        console.log('🔑 Obteniendo token de Wompi...');
        
        // Obtener token de Wompi
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

        // ✅ REDIRECT_URL que apunta a tu endpoint de redirección
        const redirectUrl = `${REDIRECT_BASE_URL}/api/wompi/redirect-to-app?referencia=${referencia}`;
        
        // ✅ PAYLOAD para Wompi SV
        const payload = {
            data: {
                attributes: {
                    name: descripcion || "Renta de Vehículo",
                    description: `Renta - ${clienteId || 'Cliente'}`,
                    single_use: true,
                    collect_shipping: false,
                    currency: "USD",
                    amount_in_cents: montoCents,
                    redirect_url: redirectUrl, // ✅ Tu URL de redirección
                    reference: referencia,
                }
            }
        };

        // ✅ URL CORREGIDA
        const apiUrl = WOMPI_API_URL.endsWith('/v1/') 
            ? WOMPI_API_URL + 'payment_links'
            : WOMPI_API_URL.replace(/\/$/, '') + '/v1/payment_links';

        console.log('📤 Enviando a Wompi SV:', {
            url: apiUrl,
            referencia: referencia,
            monto: `$${(montoCents / 100).toFixed(2)} USD`
        });

        // Crear enlace en Wompi
        const wompiResp = await axios.post(
            apiUrl,
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

        console.log('✅ Respuesta de Wompi SV recibida');

        if (!wompiResp.data.data) {
            throw new Error('Respuesta inválida de Wompi');
        }

        // Guardar transacción
        transacciones.set(referencia, {
            montoCents,
            clienteId,
            descripcion,
            estado: 'pendiente',
            fecha: new Date(),
            idEnlace: wompiResp.data.data.id,
            moneda: "USD",
            urlEnlace: wompiResp.data.data.attributes.checkout_url
        });

        res.json({
            ok: true,
            urlEnlace: wompiResp.data.data.attributes.checkout_url,
            idEnlace: wompiResp.data.data.id,
            referencia: referencia,
        });

    } catch (err) {
        console.error('❌ Error generando enlace:', {
            message: err.message,
            response: err.response?.data,
            status: err.response?.status,
            url: err.config?.url
        });
        
        let errorMessage = 'Error al generar enlace de pago';
        let detalles = null;

        if (err.response?.data) {
            errorMessage = err.response.data.error?.message || 
                          err.response.data.mensajes?.[0] || 
                          'Error en la respuesta de Wompi';
            detalles = err.response.data;
        } else if (err.code === 'ECONNREFUSED') {
            errorMessage = 'No se puede conectar con el servicio de pagos';
        } else if (err.response?.status === 404) {
            errorMessage = 'Endpoint no encontrado. Verifica la URL de Wompi API';
        }

        res.status(500).json({ 
            ok: false, 
            error: errorMessage,
            detalles: detalles
        });
    }
});

// 2. ✅ ENDPOINT PARA REDIRIGIR A LA APP MÓVIL
app.get('/api/wompi/redirect-to-app', (req, res) => {
    const { referencia } = req.query;
    
    console.log('🔀 Redirigiendo a app móvil para referencia:', referencia);
    
    // Para app móvil, redirigimos a un Deep Link
    const deepLink = `tuapp://renta/resultado?referencia=${referencia}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Pago completado</title>
            <script>
                // Intentar abrir la app
                window.location.href = '${deepLink}';
                
                // Si no funciona después de 2 segundos, mostrar mensaje
                setTimeout(function() {
                    document.getElementById('message').innerHTML = 
                        '<p>Si no se abre automáticamente, <a href="${deepLink}">haz clic aquí</a></p>';
                }, 2000);
            </script>
        </head>
        <body>
            <div style="text-align: center; margin-top: 50px;">
                <h2>¡Pago procesado!</h2>
                <p>Redirigiendo a la aplicación...</p>
                <div id="message"></div>
            </div>
        </body>
        </html>
    `);
});

// 3. ✅ WEBHOOK - ESTE ES EL QUE YA TIENES CONFIGURADO
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

// 4. Endpoint para consultar estado
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
    console.log(`🔀 Redirect: ${REDIRECT_BASE_URL}/api/wompi/redirect-to-app`);
    console.log(`🌐 Wompi API: ${WOMPI_API_URL}`);
});