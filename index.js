require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Configuración de Wompi para El Salvador
const WOMPI_API_URL = 'https://api.wompi.sv/v1/';
const WOMPI_AUTH_URL = 'https://id.wompi.sv/';
const WEBHOOK_URL = 'https://rideandbuypay.onrender.com/webhook/wompi';
const REDIRECT_BASE_URL = 'https://rideandbuypay.onrender.com';

// Límites en dólares
const MONTO_MAXIMO = 100000;  // Máximo permitido en centavos (1000 USD)
const MONTO_MINIMO = 100;     // Mínimo permitido en centavos (1 USD)

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
        configuracionCorrecta: !!(clientId && clientSecret),
        entorno: 'WOMPI EL SALVADOR'
    });
});

// 1. Generar enlace de pago - WOMPI
app.post('/api/wompi/generar-enlace-renta', async (req, res) => {
    try {
        const { referencia, montoCents, descripcion, clienteId } = req.body;

        console.log('🚗 Generando enlace de pago:', { referencia, montoCents });

        // Verificar credenciales
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

        // Configurar la solicitud a Wompi
        const payload = {
            "identificadorEnlaceComercio": referencia,
            "monto": montoCents,
            "nombreProducto": descripcion || "Renta de Vehículo",
            "formaPago": {
                "permitirTarjetaCreditoDebido": true,
                "permitirPagoConPuntoAgricola": false,
                "permitirPagoEnCuotasAgricola": false
            },
            "cantidadMaximaCuotas": "Tres",
            "infoProducto": {
                "descripcionProducto": "Renta de vehículo por 1 día",
                "urlImagenProducto": "https://link-a-imagen.com/imagen.jpg"
            },
            "configuracion": {
                "urlRedirect": `${REDIRECT_BASE_URL}/api/wompi/redirect-to-app?referencia=${referencia}`,
                "esMontoEditable": false,
                "esCantidadEditable": false,
                "cantidadPorDefecto": 1,
                "duracionInterfazIntentoMinutos": 15,
                "urlRetorno": `${REDIRECT_BASE_URL}/api/wompi/return`,
                "emailsNotificacion": "example@correo.com",
                "urlWebhook": WEBHOOK_URL,
                "notificarTransaccionCliente": true
            },
            "vigencia": {
                "fechaInicio": new Date().toISOString(),
                "fechaFin": "2025-06-25T16:45:19.206Z"
            }
        };

        // Solicitar enlace de pago a Wompi
        const apiUrl = WOMPI_API_URL + 'payment_links';

        console.log('🌐 Enviando a Wompi:', apiUrl);

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

        console.log('✅ Respuesta de Wompi recibida:', wompiResp.data);

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
            urlEnlace: wompiResp.data.data.attributes?.checkout_url || wompiResp.data.data.url
        });

        res.json({
            ok: true,
            urlEnlace: wompiResp.data.data.attributes?.checkout_url || wompiResp.data.data.url,
            urlQrCodeEnlace: wompiResp.data.data.attributes?.qr_code_url,
            idEnlace: wompiResp.data.data.id,
            referencia: referencia,
        });

    } catch (err) {
        console.error('❌ Error generando enlace:', err);
        
        res.status(500).json({ 
            ok: false, 
            error: err.message,
            detalles: err.response?.data
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de pagos corriendo en puerto ${PORT}`);
    console.log(`🔧 Entorno: WOMPI EL SALVADOR`);
});
