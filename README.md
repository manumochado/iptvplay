# iptvplay

Cliente web React + API Node (Express) para listas IPTV tipo **Xtream Codes**: directo (por bloques), películas VOD y series.

## Desarrollo local

```bash
npm run install:all
cp .env.example .env   # edita IPTV_BASE_URL, IPTV_USERNAME, IPTV_PASSWORD
npm run dev
```

- Frontend: http://localhost:5173  
- API: http://localhost:3001  

## Despliegue en Railway

1. Conecta este repositorio en [Railway](https://railway.app).
2. Variables de entorno del servicio:
   - `IPTV_BASE_URL` (muchas veces **`http://`** en el puerto del panel, no `https://`)
   - `IPTV_USERNAME`
   - `IPTV_PASSWORD`  
   Opcionales: `IPTV_TLS_INSECURE=1` si el SSL falla; `IPTV_IPV4=0` solo si necesitas desactivar el forzado a IPv4.

**502 en producción:** suele ser que el **panel IPTV no responde** desde la IP de Railway (bloqueo geográfico, anti-bot, o solo redes residenciales). Revisa los **logs del deploy** en Railway: el servidor ahora registra el error. Si el panel devuelve **403**, casi seguro bloquea datacenters: en ese caso hace falta un **VPS/proxy** con otra IP o que el proveedor permita la IP de Railway.
3. Genera dominio público. El mismo proceso sirve el **build de Vite** y la **API** (`/api/*`).

El build y el arranque están definidos en `railway.toml` y en `npm run build:railway` / `npm start`.

## Seguridad

No subas `.env` al repositorio. La URL pública del despliegue actúa como proxy hacia tu panel; valora añadir autenticación o restricción de acceso si la expones en internet.
