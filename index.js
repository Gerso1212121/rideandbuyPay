require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ CONFIGURACIÓN PARA WOMPI EL SALVADOR
const WOMPI_API_URL = process.env.WOMPI_API || 'https://api.wompi.sv/';
const WOMPI_AUTH_URL = process.env.WOMPI_AUTH || 'https://id.wompi.sv/';
const WEBHOOK_URL = 'https://rideandbuypay.onrender.com/webhook/wompi';
const REDIRECT_BASE_URL = 'https://rideandbuypay.onrender.com';

// Límites en dólares
const MONTO_MAXIMO = 100000; // $1000 USD
const MONTO_MINIMO = 100;    // $1 USD

const transacciones = new Map();

// Endpoint de debug
app.get('/api/debug/wompi-config', (req, res) => {
    const clientId = process.env.WOMPI_CLIENT_ID;
    const clientSecret = process.env.WOMPI_CLIENT_SECRET;
    
    res.json({
        WOMPI_CLIENT_ID: clientId ? 'CONFIGURADO' : 'FALTANTE',
        WOMPI_CLIENT_SECRET: clientSecret ? 'CONFIGURADO' : 'FALTANTE',
        WOMPI_API: WOMPI_API_URL,
        WOMPI_AUTH: WOMPI_AUTH_URL,
        WEBHOOK_URL: WEBHOOK_URL,
        REDIRECT_BASE_URL: REDIRECT_BASE_URL,
        MONTO_MAXIMO: `${MONTO_MAXIMO / 100} USD`,
        MONTO_MINIMO: `${MONTO_MINIMO / 100} USD`,
        configuracionCorrecta: !!(clientId && clientSecret),
        entorno: 'WOMPI EL SALVADOR'
    });
});

// 1. Generar enlace de pago - CON MONEDA EXPLÍCITA
app.post('/api/wompi/generar-enlace-renta', async (req, res) => {
    try {
        const { referencia, montoCents, descripcion, clienteId } = req.body;

        console.log('🚗 Generando enlace de pago:', { referencia, montoCents });

        // ✅ VERIFICAR CREDENCIALES
        if (!process.env.WOMPI_CLIENT_ID || !process.env.WOMPI_CLIENT_SECRET) {
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

        // ✅ ESTRUCTURA CON MONEDA USD EXPLÍCITA
        const payload = {
            identificadorEnlaceComercio: referencia,
            monto: montoCents, // En centavos
            nombreProducto: descripcion || "Renta de Vehículo",
            moneda: "USD", // ✅ AGREGADO: Moneda explícita
            formaPago: {
                permitirTarjetaCreditoDebido: true,
                permitirPagoConPuntoAgricola: false,
                permitirPagoEnCuotasAgricola: false,
                permitirPagoEnBitcoin: false,
                permitePagoQuickPay: false
            },
            infoProducto: {
                descripcionProducto: `Renta para cliente: ${clienteId || 'N/A'}`,
                urlImagenProducto: null
            },
            configuracion: {
                urlRedirect: `${REDIRECT_BASE_URL}/api/wompi/redirect-to-app?referencia=${referencia}`,
                esMontoEditable: false,
                esCantidadEditable: false,
                cantidadPorDefecto: 1,
                duracionInterfazIntentoMinutos: 30,
                urlWebhook: WEBHOOK_URL,
                notificarTransaccionCliente: false
            },
            vigencia: {
                fechaInicio: new Date().toISOString(),
                fechaFin: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            },
            limitesDeUso: {
                cantidadMaximaPagosExitosos: 1,
                cantidadMaximaPagosFallidos: 3
            }
        };

        // ✅ URL CORRECTA PARA WOMPI SV
        const apiUrl = WOMPI_API_URL + 'EnlacePago';

        console.log('📤 Enviando a Wompi El Salvador:', {
            url: apiUrl,
            referencia: referencia,
            monto: `$${(montoCents / 100).toFixed(2)} USD`,
            montoEnCentavos: montoCents
        });

        console.log('🔧 Payload con moneda USD:', JSON.stringify(payload, null, 2));

        // Crear enlace en Wompi SV
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

        console.log('✅ Respuesta de Wompi SV:', wompiResp.data);

        // Guardar transacción
        transacciones.set(referencia, {
            montoCents,
            clienteId,
            descripcion,
            estado: 'pendiente',
            fecha: new Date(),
            idEnlace: wompiResp.data.idEnlace,
            moneda: "USD",
            urlEnlace: wompiResp.data.urlEnlace
        });

        res.json({
            ok: true,
            urlEnlace: wompiResp.data.urlEnlace,
            idEnlace: wompiResp.data.idEnlace,
            referencia: referencia,
        });

    } catch (err) {
        console.error('❌ Error generando enlace:', {
            message: err.message,
            response: err.response?.data,
            status: err.response?.status
        });
        
        let errorMessage = 'Error al generar enlace de pago';
        let detalles = err.response?.data;

        // ✅ MEJOR MANEJO DE ERRORES ESPECÍFICOS
        if (err.response?.data?.mensajes) {
            errorMessage = err.response.data.mensajes.join(', ');
        }

        res.status(500).json({ 
            ok: false, 
            error: errorMessage,
            detalles: detalles
        });
    }
});

// Los demás endpoints se mantienen igual...
// 2. ENDPOINT PARA REDIRIGIR 
app.get('/api/wompi/redirect-to-app', (req, res) => {
    const { referencia } = req.query;
    
    console.log('🔀 Redirigiendo a app móvil para referencia:', referencia);
    
    const deepLink = `ezride://payment/result?referencia=${referencia}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Pago completado</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script>
                setTimeout(() => window.location.href = '${deepLink}', 100);
                setTimeout(() => {
                    document.getElementById('status').innerHTML = 
                        '<h3>✅ Pago procesado</h3><p>Redirigiendo...</p>';
                }, 500);
            </script>
            <style>
                body { font-family: Arial; text-align: center; padding: 50px 20px; background: #f5f5f5; }
                .container { background: white; padding: 30px; border-radius: 10px; margin: 0 auto; max-width: 400px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div id="status">
                    <h2>🔄 Procesando...</h2>
                    <p>Por favor espera</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// 3. WEBHOOK 
app.post('/webhook/wompi', async (req, res) => {
    console.log('📥 Webhook recibido de Wompi:', JSON.stringify(req.body, null, 2));
    
    const event = req.body?.event || req.body?.Evento;
    const data = req.body?.data || req.body?.Datos;
    const reference = data?.reference || data?.IdentificadorEnlaceComercio;

    if (!reference) {
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
    console.log(`🔧 Entorno: WOMPI EL SALVADOR`);
    console.log(`💰 Moneda: USD`);
    console.log(`🔗 Webhook: ${WEBHOOK_URL}`);
    console.log(`🔀 Redirect: ${REDIRECT_BASE_URL}/api/wompi/redirect-to-app`);
    console.log(`🌐 Wompi API: ${WOMPI_API_URL}`);
});