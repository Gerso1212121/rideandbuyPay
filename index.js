require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ CONFIGURACIÓN MEJORADA
const WOMPI_API_URL = process.env.WOMPI_API || 'https://api.wompi.sv/';
const WOMPI_AUTH_URL = process.env.WOMPI_AUTH || 'https://id.wompi.sv/';
const WEBHOOK_URL = 'https://rideandbuypay.onrender.com/webhook/wompi';
const REDIRECT_BASE_URL = 'https://rideandbuypay.onrender.com';

const MONTO_MAXIMO = 100000;
const MONTO_MINIMO = 100;

const transacciones = new Map();

// ✅ NUEVO: Detectar si es app móvil
function esAppMovil(userAgent) {
    return userAgent && (
        userAgent.includes('EzRide') ||
        userAgent.includes('Flutter') ||
        userAgent.includes('Android') ||
        userAgent.includes('iOS') ||
        userAgent.includes('Mobile') ||
        userAgent.includes('App')
    );
}

// 1. ✅ GENERAR ENLACE MEJORADO - Con detección de app
app.post('/api/wompi/generar-enlace-renta', async (req, res) => {
    try {
        const { referencia, montoCents, descripcion, clienteId, fromApp = false } = req.body;
        const userAgent = req.headers['user-agent'] || '';

        console.log('🚗 Generando enlace de pago:', { 
            referencia, 
            montoCents, 
            fromApp,
            userAgent: userAgent.substring(0, 100) 
        });

        // ✅ DETECTAR APP MÓVIL AUTOMÁTICAMENTE
        const esDesdeApp = fromApp || esAppMovil(userAgent);

        if (!process.env.WOMPI_CLIENT_ID || !process.env.WOMPI_CLIENT_SECRET) {
            return res.status(500).json({ 
                ok: false, 
                error: 'Configuración incompleta del servicio de pagos' 
            });
        }

        const montoDolares = montoCents;
        
        if (montoDolares > (MONTO_MAXIMO / 100)) {
            return res.status(400).json({
                ok: false,
                error: `Monto máximo permitido es $${MONTO_MAXIMO / 100} USD`
            });
        }

        if (montoDolares < (MONTO_MINIMO / 100)) {
            return res.status(400).json({
                ok: false,
                error: `Monto mínimo permitido es $${MONTO_MINIMO / 100} USD`
            });
        }

        console.log('🔑 Obteniendo token de Wompi...');
        
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

        // ✅ PAYLOAD MEJORADO
        const payload = {
            identificadorEnlaceComercio: referencia,
            monto: montoDolares,
            nombreProducto: descripcion || "Renta de Vehículo",
            moneda: "USD",
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

        const apiUrl = WOMPI_API_URL + 'EnlacePago';

        console.log('📤 Enviando a Wompi:', {
            referencia,
            montoEnDolares: `$${montoDolares.toFixed(2)}`,
            desdeApp: esDesdeApp
        });

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

        console.log('✅ Respuesta de Wompi:', wompiResp.data);

        // ✅ GUARDAR INFORMACIÓN DE LA APP
        transacciones.set(referencia, {
            montoCents,
            clienteId,
            descripcion,
            estado: 'pendiente',
            fecha: new Date(),
            idEnlace: wompiResp.data.idEnlace,
            moneda: "USD",
            urlEnlace: wompiResp.data.urlEnlace,
            desdeApp: esDesdeApp // ✅ GUARDAR SI ES DESDE APP
        });

        res.json({
            ok: true,
            urlEnlace: wompiResp.data.urlEnlace,
            idEnlace: wompiResp.data.idEnlace,
            referencia: referencia,
            desdeApp: esDesdeApp
        });

    } catch (err) {
        console.error('❌ Error generando enlace:', err.message);
        
        let errorMessage = 'Error al generar enlace de pago';
        if (err.response?.data?.mensajes) {
            errorMessage = err.response.data.mensajes.join(', ');
        }

        res.status(500).json({ 
            ok: false, 
            error: errorMessage,
            detalles: err.response?.data
        });
    }
});

// 2. ✅ ENDPOINT DE REDIRECCIÓN MEJORADO
app.get('/api/wompi/redirect-to-app', (req, res) => {
    const { referencia } = req.query;
    const userAgent = req.headers['user-agent'] || '';
    
    console.log('🔀 Redirección desde Wompi:', { 
        referencia, 
        userAgent: userAgent.substring(0, 100) 
    });

    // ✅ OBTENER TRANSACCIÓN Y ESTADO ACTUAL
    const transaccion = transacciones.get(referencia);
    const estado = transaccion?.estado || 'pendiente';
    const desdeApp = transaccion?.desdeApp || false;

    console.log(`📊 Estado para redirección: ${referencia} -> ${estado}, DesdeApp: ${desdeApp}`);

    // ✅ DETECTAR SI ES APP MÓVIL
    const esApp = desdeApp || esAppMovil(userAgent);

    if (esApp) {
        // ✅ REDIRIGIR A APP CON ESTADO ACTUAL
        console.log('📱 Redirigiendo a app móvil');
        const deepLink = `ezride://payment/result?referencia=${referencia}&estado=${estado}`;
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Redirigiendo a EzRide</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <script>
                    // ✅ INTENTAR ABRIR APP INMEDIATAMENTE
                    window.location.href = '${deepLink}';
                    
                    // ✅ FALLBACK DESPUÉS DE 3 SEGUNDOS
                    setTimeout(function() {
                        document.getElementById('appContent').style.display = 'none';
                        document.getElementById('fallbackContent').style.display = 'block';
                    }, 3000);

                    // ✅ ALTERNATIVA: CERRAR WEBVIEW SI ESTÁ EN APP
                    function cerrarWebView() {
                        if (window.flutter_inappwebview) {
                            window.flutter_inappwebview.callHandler('cerrarWebView');
                        }
                    }
                    
                    // Intentar cerrar después de redirigir
                    setTimeout(cerrarWebView, 1000);
                </script>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        text-align: center; 
                        padding: 50px 20px; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        margin: 0;
                    }
                    .container { 
                        background: rgba(255,255,255,0.1); 
                        padding: 40px; 
                        border-radius: 15px; 
                        margin: 0 auto; 
                        max-width: 500px;
                        backdrop-filter: blur(10px);
                        border: 1px solid rgba(255,255,255,0.2);
                    }
                    .btn {
                        background: white;
                        color: #667eea;
                        padding: 12px 24px;
                        border-radius: 25px;
                        text-decoration: none;
                        display: inline-block;
                        margin: 10px;
                        font-weight: bold;
                        border: none;
                        cursor: pointer;
                    }
                    .hidden {
                        display: none;
                    }
                    .spinner {
                        border: 4px solid rgba(255,255,255,0.3);
                        border-radius: 50%;
                        border-top: 4px solid white;
                        width: 40px;
                        height: 40px;
                        animation: spin 1s linear infinite;
                        margin: 20px auto;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    .status-badge {
                        background: rgba(255,255,255,0.2);
                        padding: 8px 16px;
                        border-radius: 20px;
                        display: inline-block;
                        margin: 10px;
                        font-size: 14px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div id="appContent">
                        <h2>🎯 Procesando Pago</h2>
                        <div class="spinner"></div>
                        <p>Estamos redirigiéndote a la app...</p>
                        <div class="status-badge">
                            <strong>Estado:</strong> ${estado.toUpperCase()}
                        </div>
                        <div class="status-badge">
                            <strong>Referencia:</strong> ${referencia}
                        </div>
                    </div>
                    
                    <div id="fallbackContent" class="hidden">
                        <h2>📱 Abrir en EzRide</h2>
                        <p>Si la redirección automática no funciona:</p>
                        <a href="${deepLink}" class="btn">Abrir en EzRide App</a>
                        <p style="margin-top: 20px; font-size: 12px; opacity: 0.8;">
                            O copia este enlace manualmente:<br>
                            <code style="background: rgba(0,0,0,0.2); padding: 5px; border-radius: 5px;">
                                ${deepLink}
                            </code>
                        </p>
                    </div>
                </div>
            </body>
            </html>
        `);
    } else {
        // ✅ MOSTRAR PÁGINA WEB PARA NAVEGADOR NORMAL
        console.log('🌐 Mostrando página web normal');
        res.send(generarPaginaWebResultado(referencia, estado));
    }
});

// 3. ✅ WEBHOOK MEJORADO
// ✅ WEBHOOK CORREGIDO - Manejar correctamente el formato de Wompi El Salvador
app.post('/webhook/wompi', async (req, res) => {
    console.log('📥 Webhook recibido:', JSON.stringify(req.body, null, 2));
    
    try {
        // ✅ FORMATO WOMPI EL SALVADOR - CORREGIDO
        const resultadoTransaccion = req.body.ResultadoTransaccion;
        const referencia = req.body.EnlacePago?.IdentificadorEnlaceComercio;
        
        if (!referencia) {
            console.error('❌ Referencia faltante en webhook');
            return res.status(400).json({ error: 'Referencia faltante' });
        }

        console.log(`🔍 Procesando webhook - Referencia: ${referencia}, Resultado: ${resultadoTransaccion}`);

        const transaccion = transacciones.get(referencia);
        
        if (!transaccion) {
            console.warn('⚠️ Transacción no encontrada en webhook:', referencia);
            return res.status(404).json({ error: 'Transacción no encontrada' });
        }

        let estadoAnterior = transaccion.estado;

        // ✅ MANEJAR ESTADOS SEGÚN WOMPI EL SALVADOR
        switch (resultadoTransaccion) {
            case 'ExitosaAprobada':
                transaccion.estado = 'aprobado';
                transaccion.fechaAprobacion = new Date();
                transaccion.idTransaccion = req.body.IdTransaccion;
                console.log('✅ Pago APROBADO via Webhook:', referencia);
                
                // ✅ ACTUALIZAR INMEDIATAMENTE EN EL MAPA
                transacciones.set(referencia, transaccion);
                console.log('🔄 Estado actualizado en memoria:', transaccion.estado);
                break;

            case 'ExitosaDeclinada':
                transaccion.estado = 'rechazado';
                transaccion.razon = 'Transacción declinada';
                console.log('❌ Pago RECHAZADO via Webhook:', referencia);
                transacciones.set(referencia, transaccion);
                break;

            case 'Fallida':
                transaccion.estado = 'fallido';
                transaccion.error = 'Transacción fallida';
                console.log('💥 Pago FALLIDO via Webhook:', referencia);
                transacciones.set(referencia, transaccion);
                break;

            default:
                console.log('ℹ️ Estado no manejado:', resultadoTransaccion);
        }

        // ✅ LOG DE CAMBIO DE ESTADO
        if (estadoAnterior !== transaccion.estado) {
            console.log(`🔄 Estado actualizado: ${estadoAnterior} → ${transaccion.estado}`);
        }

        res.json({ 
            ok: true, 
            mensaje: 'Webhook procesado',
            referencia: referencia,
            estado: transaccion.estado 
        });

    } catch (error) {
        console.error('❌ Error en webhook:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 4. ✅ ENDPOINTS ADICIONALES (se mantienen igual)
// ✅ ENDPOINT DE ESTADO MEJORADO
app.get('/api/wompi/estado/:referencia', (req, res) => {
    const { referencia } = req.params;
    
    console.log(`🔍 Consultando estado para: ${referencia}`);
    
    const transaccion = transacciones.get(referencia);

    if (!transaccion) {
        console.warn('⚠️ Transacción no encontrada:', referencia);
        return res.status(404).json({ 
            ok: false, 
            error: 'Transacción no encontrada',
            referencia: referencia 
        });
    }

    console.log(`📊 Estado encontrado: ${referencia} -> ${transaccion.estado}`);
    
    res.json({
        ok: true,
        referencia,
        estado: transaccion.estado,
        montoCents: transaccion.montoCents,
        fecha: transaccion.fecha,
        idTransaccion: transaccion.idTransaccion,
        moneda: transaccion.moneda,
        desdeApp: transaccion.desdeApp
    });
});
app.get('/api/health', (req, res) => {
    res.json({ 
        ok: true, 
        message: 'Servidor de pagos funcionando',
        transaccionesActivas: transacciones.size,
        moneda: 'USD',
        timestamp: new Date().toISOString()
    });
});

// ✅ FUNCIÓN AUXILIAR PARA PÁGINA WEB
function generarPaginaWebResultado(referencia, estado) {
    const config = {
        'aprobado': { titulo: '✅ Pago Exitoso', mensaje: 'Tu pago ha sido procesado exitosamente.', color: '#10B981' },
        'rechazado': { titulo: '❌ Pago Rechazado', mensaje: 'El pago fue rechazado. Intenta con otro método.', color: '#EF4444' },
        'fallido': { titulo: '💥 Error en Pago', mensaje: 'Ocurrió un error al procesar tu pago.', color: '#F59E0B' },
        'pendiente': { titulo: '🔄 Procesando Pago', mensaje: 'Estamos verificando tu transacción.', color: '#6366F1' }
    };

    const conf = config[estado] || config.pendiente;

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>${conf.titulo}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial; text-align: center; padding: 50px 20px; background: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; margin: 0 auto; max-width: 400px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>${conf.titulo}</h1>
            <p>${conf.mensaje}</p>
            <p><strong>Referencia:</strong> ${referencia}</p>
            <p><strong>Estado:</strong> ${estado}</p>
        </div>
    </body>
    </html>
    `;
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de pagos corriendo en puerto ${PORT}`);
    console.log(`🔧 Entorno: WOMPI EL SALVADOR`);
    console.log(`💰 Moneda: USD`);
    console.log(`🔗 Webhook: ${WEBHOOK_URL}`);
    console.log(`🔀 Redirect: ${REDIRECT_BASE_URL}/api/wompi/redirect-to-app`);
});