# JS ↔ Native Bridge

Bidirectional message bridge between the Next.js web app loaded inside the
WebView (`frontend/`) and the React Native shell (`seven-arena-app/`).

The bridge supports three patterns:

- **Fire-and-forget from web → native** (`bridge.send`)
- **Request / response from web → native** (`bridge.request`, returns a Promise)
- **Spontaneous push from native → web** (`bridge.emit`, with web-side `bridge.on`)

Built on top of `react-native-webview`'s `postMessage` (web → native) and
`webViewRef.injectJavaScript` (native → web). Both directions are wrapped in
a single envelope schema with versioning, optional message ids for response
correlation, and uniform error handling.

---

## 1. Envelope schema

Every message — in either direction — is JSON of the form:

```jsonc
{
  "v": 1,                  // protocol version. Receivers MUST ignore other values.
  "id": "abc123",          // optional. Present on requests and on their matching response.
  "type": "auth.session",  // namespaced event/method name. REQUIRED.
  "payload": {  },         // optional, free-form per type.

  // Only present on responses (native → web for a request):
  "ok": true,              // false on error
  "error": "…"             // human-readable message when ok === false
}
```

A receiver that gets a malformed JSON, an unknown `v`, or a missing `type`
silently drops the message. The bridge never throws into the host app.

---

## 2. Web side API (`frontend/lib/native-bridge.ts`)

```ts
import { send, request, on, off, isAvailable } from "@/lib/native-bridge";
```

| Function | Description |
|----------|-------------|
| `isAvailable(): boolean` | `true` if running inside the WebView (and therefore the native side will receive messages). Always `false` in a regular browser. |
| `send(type, payload?): void` | Fire-and-forget. No response expected. |
| `request<T>(type, payload?, opts?): Promise<T>` | Sends and waits for a matching response. Default timeout 5000 ms; configurable via `opts.timeoutMs`. Rejects on timeout, on `ok: false` from native, or if `isAvailable()` is `false`. |
| `on(type, handler): () => void` | Subscribe to spontaneous events from native (e.g. `network.status`, `app.background`). Returns an unsubscribe function. |
| `off(type, handler): void` | Manual unsubscribe. |

The module installs `window.__sevenNativeReceive` on import. The native side
uses that hook to deliver messages — keep `frontend/app/providers.tsx`
importing `@/lib/native-bridge` so the hook is registered on every route.

---

## 3. Native side API (`seven-arena-app/lib/native-bridge.ts`)

```ts
import { createNativeBridge, isBridgeEnvelope } from '../lib/native-bridge';

const webViewRef = useRef<WebView | null>(null);
const bridge = createNativeBridge(webViewRef);

bridge.registerHandler('auth.session', async (payload) => {
  await AsyncStorage.setItem('seven.session', JSON.stringify(payload));
  return { saved: true };
});

// Inside <WebView onMessage={...}>:
const handleMessage = async (e) => {
  const raw = e.nativeEvent?.data;
  if (!raw) return;
  if (isBridgeEnvelope(raw)) await bridge.handleIncoming(raw);
};
```

| Function | Description |
|----------|-------------|
| `createNativeBridge(webViewRef)` | Creates a bridge instance bound to a `WebView` ref. |
| `bridge.registerHandler(type, fn)` | Registers a handler. The return value (or thrown error) is what the web's `bridge.request` resolves/rejects with. Sync or async. |
| `bridge.unregisterHandler(type)` | Removes a handler. |
| `bridge.emit(type, payload?)` | Pushes a spontaneous event to the web (subscribed via `bridge.on`). |
| `bridge.handleIncoming(raw)` | Call from `onMessage`. Parses, routes, responds. No-op if `raw` isn't a valid envelope. |
| `isBridgeEnvelope(raw)` | Guard so the WebView's `onMessage` can route bridge messages here and forward legacy payloads elsewhere. |

---

## 4. Registered handlers (native side)

These are wired in `seven-arena-app/app/index.tsx`:

| `type` | Direction | Request payload | Response payload | Errors |
|--------|-----------|-----------------|------------------|--------|
| `auth.session` | web → native | `{ kind: "athlete" \| "driver" \| "admin", role, …profile }` | `{ saved: true }` | AsyncStorage failure |
| `device.info` | web → native | _none_ | `{ os, osVersion, appVersion, protocol }` | _none_ |

Add new handlers here as we extend the bridge for tracking, push, camera, etc.
Always document the new type in this table when you register it.

---

## 5. Spontaneous events (native → web)

These don't exist yet but the channel is ready. Examples planned:

| `type` | Direction | Payload | Trigger |
|--------|-----------|---------|---------|
| `network.status` | native → web | `{ online: boolean }` | NetInfo state change in the RN shell |
| `push.token` | native → web | `{ token: string, platform: "ios" \| "android" }` | After Expo notifications registers the device |
| `app.foreground` / `app.background` | native → web | `{}` | `AppState` transitions |
| `tracking.position` | native → web | `{ lat, lng, speed?, heading?, ts }` | Background-location updates while a trip is active |

To dispatch one from native: `bridge.emit("network.status", { online: false });`

To receive one on the web:

```ts
import { on } from "@/lib/native-bridge";

useEffect(() => {
  const off = on("network.status", (payload) => {
    console.log("network changed", payload);
  });
  return off;
}, []);
```

---

## 6. End-to-end examples

### a) Fire-and-forget: persist session after login

```ts
// frontend/app/m/login/page.tsx (after successful mobileLogin)
import { send } from "@/lib/native-bridge";

send("auth.session", {
  kind: "athlete",
  role: "ATHLETE",
  athleteId: result.athleteId,
  profile: result.profile,
});
```

### b) Request/response: read device info

```ts
import { request, isAvailable } from "@/lib/native-bridge";

if (isAvailable()) {
  try {
    const info = await request<{
      os: string;
      osVersion: string;
      appVersion: string | null;
      protocol: number;
    }>("device.info", undefined, { timeoutMs: 2000 });
    console.log("[native]", info);
  } catch (err) {
    console.warn("device.info failed", err);
  }
}
```

### c) Subscribe to a native push

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

## 7. Error handling guarantees

- Web side: `request` rejects on timeout, on `{ ok: false }`, or if not in a
  WebView. `send` and `on` are no-ops outside a WebView; no exceptions
  bubble.
- Native side: handler exceptions are caught and translated into
  `{ ok: false, error: <message> }`. Bad JSON is dropped silently. Missing
  handlers respond with `{ ok: false, error: "no handler registered…" }` so
  the web's promise rejects rather than hangs.
- Either side missing or the other side gone (e.g. WebView reload mid-flight)
  → the request times out and rejects; nothing crashes.

---

## 8. Cross-platform notes (iOS / Android)

- `react-native-webview`'s `postMessage` and `injectJavaScript` are
  symmetrical on iOS and Android, so the same envelope works on both.
- The injection script wraps the call in an IIFE and a `try/catch`, so a
  WebView that hasn't loaded the bridge module yet (e.g. message arrives
  during page navigation) won't error out.
- `window.__sevenNativeReceive` is registered by the side-effect import in
  `frontend/app/providers.tsx`, ensuring it exists on every route the
  WebView might navigate to.

---

## 9. Backwards compatibility

The native `onMessage` handler still accepts the original fire-and-forget
session payload (`{ kind, role, athleteId/driverId, profile }`) so existing
APKs in the field keep working until they're upgraded.
