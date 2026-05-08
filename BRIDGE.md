# Bridge JS ↔ Nativo

Puente bidireccional de mensajes entre la aplicación web Next.js cargada
dentro del WebView (`frontend/`) y el contenedor React Native
(`seven-arena-app/`).

El bridge soporta tres patrones de comunicación:

- **Disparar y olvidar de web → nativo** (`bridge.send`)
- **Solicitud / respuesta de web → nativo** (`bridge.request`, devuelve una Promise)
- **Notificación espontánea de nativo → web** (`bridge.emit` en RN, con `bridge.on` en web)

Construido sobre `postMessage` de `react-native-webview` (web → nativo) y
`webViewRef.injectJavaScript` (nativo → web). Ambas direcciones se envuelven
en un único esquema de sobre con versionado, identificadores opcionales para
correlacionar respuestas y manejo uniforme de errores.

---

## 1. Esquema del sobre

Todos los mensajes — en cualquier dirección — son JSON con la forma:

```jsonc
{
  "v": 1,                  // Versión del protocolo. Los receptores DEBEN ignorar otros valores.
  "id": "abc123",          // Opcional. Presente en solicitudes y en su respuesta correlacionada.
  "type": "auth.session",  // Nombre del evento o método (con namespace). REQUERIDO.
  "payload": { },          // Opcional, formato libre según el tipo.

  // Solo presente en respuestas (nativo → web tras una solicitud):
  "ok": true,              // false si hubo error
  "error": "…"             // mensaje legible cuando ok === false
}
```

Si un receptor recibe JSON malformado, una `v` desconocida o le falta `type`,
descarta el mensaje silenciosamente. El bridge nunca lanza excepciones hacia
la aplicación que lo aloja.

---

## 2. API del lado web (`frontend/lib/native-bridge.ts`)

```ts
import { send, request, on, off, isAvailable } from "@/lib/native-bridge";
```

| Función | Descripción |
|---------|-------------|
| `isAvailable(): boolean` | `true` si está corriendo dentro del WebView (y por lo tanto el lado nativo va a recibir los mensajes). Siempre `false` en un navegador convencional. |
| `send(type, payload?): void` | Disparar y olvidar. No espera respuesta. |
| `request<T>(type, payload?, opts?): Promise<T>` | Envía y espera la respuesta correlacionada. Timeout por defecto 5000 ms; configurable con `opts.timeoutMs`. Rechaza si vence el timeout, si el nativo responde `ok: false`, o si `isAvailable()` es `false`. |
| `on(type, handler): () => void` | Suscribirse a eventos espontáneos del nativo (ej: `network.status`, `app.background`). Devuelve una función para desuscribirse. |
| `off(type, handler): void` | Desuscribir manualmente. |

El módulo instala `window.__sevenNativeReceive` al ser importado. El lado
nativo usa ese hook para entregar los mensajes — mantén
`frontend/app/providers.tsx` importando `@/lib/native-bridge` para que el
hook quede registrado en cualquier ruta del SPA.

---

## 3. API del lado nativo (`seven-arena-app/lib/native-bridge.ts`)

```ts
import { createNativeBridge, isBridgeEnvelope } from '../lib/native-bridge';

const webViewRef = useRef<WebView | null>(null);
const bridge = createNativeBridge(webViewRef);

bridge.registerHandler('auth.session', async (payload) => {
  await AsyncStorage.setItem('seven.session', JSON.stringify(payload));
  return { saved: true };
});

// Dentro de <WebView onMessage={...}>:
const handleMessage = async (e) => {
  const raw = e.nativeEvent?.data;
  if (!raw) return;
  if (isBridgeEnvelope(raw)) await bridge.handleIncoming(raw);
};
```

| Función | Descripción |
|---------|-------------|
| `createNativeBridge(webViewRef)` | Crea una instancia del bridge atada a un ref del `WebView`. |
| `bridge.registerHandler(type, fn)` | Registra un handler. El valor que retorne (o el error que lance) es lo que va a resolver/rechazar el `bridge.request` del lado web. Sync o async. |
| `bridge.unregisterHandler(type)` | Quita un handler. |
| `bridge.emit(type, payload?)` | Empuja un evento espontáneo al lado web (que se suscribe con `bridge.on`). |
| `bridge.handleIncoming(raw)` | Llamarlo desde `onMessage`. Parsea, rutea, responde. No hace nada si `raw` no es un sobre válido. |
| `isBridgeEnvelope(raw)` | Guard para que el `onMessage` del WebView pueda enrutar mensajes del bridge a este módulo y reenviar payloads legacy a otro lado. |

---

## 4. Handlers registrados (lado nativo)

Estos están conectados en `seven-arena-app/app/index.tsx`:

| `type` | Dirección | Payload de solicitud | Payload de respuesta | Errores |
|--------|-----------|----------------------|----------------------|---------|
| `auth.session` | web → nativo | `{ kind: "athlete" \| "driver" \| "admin", role, …profile }` | `{ saved: true }` | Falla del AsyncStorage |
| `permissions.status` | web → nativo | _ninguno_ | `{ notifications, location, camera, gallery }` cada uno `"granted" \| "denied" \| "undetermined" \| "blocked"` | _ninguno_ |
| `permissions.request` | web → nativo | `{ kind: "notifications" \| "location" \| "camera" \| "gallery" }` | `{ kind, state }` con el estado resultante | `kind` inválido |
| `device.open-settings` | web → nativo | _ninguno_ | `{ opened: true }` | _ninguno_ (fire-and-forget en la práctica) |
| `location.current` | web → nativo | _ninguno_ | `{ lat, lng, accuracy, ts }` | `PERMISSION_DENIED` o `PERMISSION_BLOCKED` si no hay permiso; falla del GPS |
| `push.token` | web → nativo | _ninguno_ | `{ token, platform: "ios" \| "android" }` con el Expo push token | `NO_TOKEN` si no hay permiso, no hay projectId EAS, o el dispositivo no soporta push (simulador) |

Agregá nuevos handlers acá a medida que extendamos el bridge para tracking,
push, cámara, etc. Documentá siempre el nuevo tipo en esta tabla cuando lo
registres.

---

## 5. Eventos espontáneos (nativo → web)

Conectados hoy:

| `type` | Dirección | Payload | Disparo |
|--------|-----------|---------|---------|
| `push.tap` | nativo → web | data libre del notification, típicamente `{ url, kind, id, ... }` | El usuario toca una notificación push (foreground o cold-start). El web hace `router.push(url)` si `url` empieza con `/`. |

Planeados:

| `type` | Dirección | Payload | Disparo |
|--------|-----------|---------|---------|
| `network.status` | nativo → web | `{ online: boolean }` | Cambio de estado del NetInfo en el contenedor RN |
| `app.foreground` / `app.background` | nativo → web | `{}` | Transiciones del `AppState` |
| `tracking.position` | nativo → web | `{ lat, lng, speed?, heading?, ts }` | Updates de ubicación en background mientras hay un viaje activo |

Para emitir uno desde el nativo: `bridge.emit("network.status", { online: false });`

Para recibirlo desde la web:

```ts
import { on } from "@/lib/native-bridge";

useEffect(() => {
  const off = on("network.status", (payload) => {
    console.log("cambió la red", payload);
  });
  return off;
}, []);
```

---

## 6. Ejemplos punta a punta

### a) Disparar y olvidar: persistir sesión tras login

```ts
// frontend/app/m/login/page.tsx (después de un mobileLogin exitoso)
import { send } from "@/lib/native-bridge";

send("auth.session", {
  kind: "athlete",
  role: "ATHLETE",
  athleteId: result.athleteId,
  profile: result.profile,
});
```

### b) Suscribirse a un push del nativo

```ts
import { on } from "@/lib/native-bridge";

useEffect(() => {
  const unsub = on("push.token", (payload) => {
    fetch("/api/push/register", { method: "POST", body: JSON.stringify(payload) });
  });
  return unsub;
}, []);
```

---

## 7. Garantías de manejo de errores

- **Lado web:** `request` rechaza por timeout, por `{ ok: false }` desde el
  nativo, o si no estamos dentro de un WebView. `send` y `on` no hacen nada
  fuera de un WebView; ninguna excepción escapa.
- **Lado nativo:** las excepciones del handler se atrapan y se traducen a
  `{ ok: false, error: <mensaje> }`. El JSON inválido se descarta en
  silencio. Los handlers ausentes responden con
  `{ ok: false, error: "no handler registered…" }` para que la promesa del
  web rechace en lugar de quedarse colgada.
- Si falta uno de los dos lados, o el otro desaparece a mitad de camino
  (ej: el WebView recarga durante una llamada) → la solicitud expira y
  rechaza; nada crashea.

---

## 8. Notas multiplataforma (iOS / Android)

- `postMessage` y `injectJavaScript` de `react-native-webview` son
  simétricos en iOS y Android, así que el mismo sobre funciona en ambos.
- El script inyectado va envuelto en una IIFE y un `try/catch`, así que un
  WebView que aún no cargó el módulo del bridge (ej: un mensaje llega
  durante una navegación) no genera error.
- `window.__sevenNativeReceive` lo registra el import por efecto colateral
  en `frontend/app/providers.tsx`, asegurando que existe en cualquier ruta
  a la que el WebView pueda navegar.

---

## 9. Compatibilidad hacia atrás

El handler `onMessage` del nativo todavía acepta el payload original de
disparar-y-olvidar para sesión (`{ kind, role, athleteId/driverId, profile }`)
para que las APKs ya distribuidas en campo sigan funcionando hasta que se
actualicen.
