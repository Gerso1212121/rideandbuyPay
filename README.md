# Ride & Buy Payment API

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![Wompi](https://img.shields.io/badge/Wompi-00AEEF?style=for-the-badge)
![Render](https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=black)

---

API de procesamiento de pagos para la aplicación Ride & Buy Mobile, desarrollada con Node.js y Express. Integra Wompi El Salvador como proveedor de pagos, gestionando enlaces de pago, webhooks y redirecciones para el flujo completo de transacciones.

---

## Descripción General

Este servicio actúa como intermediario entre la aplicación móvil y Wompi, gestionando:

- Generación de enlaces de pago para rentas de vehículos
- Procesamiento de webhooks para actualización de estados
- Redirección de usuarios tras la transacción (app móvil o web)
- Consulta de estados de transacciones

Desarrollado como parte del proyecto Ride & Buy Mobile, actualmente no se encuentra en producción activa.

---

## Tecnologías Utilizadas

- **Node.js**: Entorno de ejecución
- **Express.js**: Framework web
- **Axios**: Cliente HTTP para comunicación con Wompi
- **CORS**: Middleware para políticas de origen cruzado
- **Dotenv**: Gestión de variables de entorno
- **Wompi El Salvador**: Proveedor de pagos

---

## Arquitectura

El servicio expone una API REST que orquesta la comunicación entre la aplicación móvil y Wompi:

```
Aplicación Móvil
      |
      v
API de Pagos (Node.js/Express)
      |
      +------------------+
      |                  |
      v                  v
   Wompi API         Webhook
   (Generación       (Actualización
    de enlaces)       de estados)
      |                  |
      v                  v
   Redirección      Base de Datos
   (App/Web)        (en memoria)
```

---

## Flujo de Pago

1. **Inicio de Pago**: La aplicación móvil solicita un enlace de pago al endpoint `/api/wompi/generar-enlace-renta`
2. **Generación**: La API obtiene un token de Wompi y crea un enlace de pago
3. **Pago**: El usuario es redirigido a la pasarela de Wompi para completar la transacción
4. **Webhook**: Wompi notifica el resultado del pago al endpoint `/webhook/wompi`
5. **Redirección**: El usuario es redirigido a la aplicación o a una página de resultado
6. **Consulta**: La aplicación verifica el estado mediante `/api/wompi/estado/:referencia`

---

## Endpoints

### Generar Enlace de Pago

```
POST /api/wompi/generar-enlace-renta
```

**Body**:
```json
{
  "referencia": "RENT-12345",
  "montoCents": 15000,
  "descripcion": "Renta de Vehículo",
  "clienteId": "USR-001",
  "fromApp": true
}
```

**Respuesta**:
```json
{
  "ok": true,
  "urlEnlace": "https://...",
  "idEnlace": "123456",
  "referencia": "RENT-12345",
  "desdeApp": true
}
```

### Consultar Estado de Pago

```
GET /api/wompi/estado/:referencia
```

**Respuesta**:
```json
{
  "ok": true,
  "referencia": "RENT-12345",
  "estado": "aprobado",
  "montoCents": 15000,
  "fecha": "2025-01-15T10:30:00.000Z",
  "moneda": "USD",
  "desdeApp": true
}
```

### Webhook de Wompi

```
POST /webhook/wompi
```

Procesa las notificaciones de Wompi y actualiza el estado de las transacciones.

### Health Check

```
GET /api/health
```

**Respuesta**:
```json
{
  "ok": true,
  "message": "Servidor de pagos funcionando",
  "transaccionesActivas": 15,
  "moneda": "USD",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

---

## Redirección Inteligente

El sistema detecta automáticamente si la solicitud proviene de la aplicación móvil o de un navegador web:

- **App móvil**: Redirige mediante deep link (`ezride://payment/result?referencia=...&estado=...`)
- **Navegador web**: Muestra una página de resultado con información de la transacción

La detección se basa en el User-Agent y en el parámetro `fromApp` enviado en la solicitud.

---

## Variables de Entorno

```
PORT=10000
WOMPI_CLIENT_ID=your_client_id
WOMPI_CLIENT_SECRET=your_client_secret
WOMPI_API=https://api.wompi.sv/
WOMPI_AUTH=https://id.wompi.sv/
```

---

## Estados de Transacción

| Estado | Descripción |
|--------|-------------|
| `pendiente` | Pago iniciado, esperando confirmación |
| `aprobado` | Pago exitoso y verificado |
| `rechazado` | Pago declinado por el banco o Wompi |
| `fallido` | Error en el procesamiento |

---

## Desafíos Técnicos

- **Integración con Wompi El Salvador**: Adaptación a los formatos específicos de la API local
- **Manejo de webhooks**: Procesamiento asíncrono de notificaciones y actualización consistente de estados
- **Redirección multiplataforma**: Detección de entorno (app/web) y redirección apropiada
- **Persistencia en memoria**: Gestión de transacciones sin base de datos persistente
- **Manejo de errores**: Validación de montos (mínimo $1.00, máximo $1,000.00) y respuestas de Wompi

---

## Aprendizajes

- Implementación de integración con proveedor de pagos en El Salvador
- Manejo de autenticación OAuth2 con client_credentials
- Diseño de flujos de redirección para aplicaciones móviles (deep links)
- Procesamiento de webhooks y actualización de estados
- Desarrollo de API REST con Node.js y Express
- Gestión de variables de entorno y configuración

---

## Estado Actual

El servicio:
- Fue desarrollado como parte del proyecto Ride & Buy Mobile
- No se encuentra desplegado como servicio productivo
- El código puede revisarse y ejecutarse localmente
- Las integraciones originales no están activas
- Sirve como demostración de integración de pagos con Wompi

---

## Repositorio

[https://github.com/Gerson-dev11/ride-and-buy-payment-api](https://github.com/Gerson-dev11/ride-and-buy-payment-api)
