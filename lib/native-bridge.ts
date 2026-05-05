// Bidirectional bridge between the React Native shell and the Next.js web
// app loaded inside the WebView. See seven-arena-app/BRIDGE.md for the
// contract, message types, and examples.

import type { RefObject } from 'react';
import type WebView from 'react-native-webview';

const PROTOCOL_VERSION = 1;

type Envelope = {
  v: 1;
  id?: string;
  type: string;
  payload?: unknown;
  ok?: boolean;
  error?: string;
};

export type BridgeHandler = (payload: unknown) => unknown | Promise<unknown>;

export type NativeBridge = {
  registerHandler: (type: string, handler: BridgeHandler) => void;
  unregisterHandler: (type: string) => void;
  emit: (type: string, payload?: unknown) => void;
  handleIncoming: (raw: string) => Promise<void>;
};

export function createNativeBridge(webViewRef: RefObject<WebView | null>): NativeBridge {
  const handlers = new Map<string, BridgeHandler>();

  const inject = (env: Envelope): void => {
    const view = webViewRef.current;
    if (!view) return;
    const json = JSON.stringify(env);
    // Embed the JSON string as a JS literal so the WebView side receives
    // exactly the same text we serialised.
    const literal = JSON.stringify(json);
    const script = `(function(){try{var fn=window.__sevenNativeReceive;if(typeof fn==='function'){fn(${literal});}}catch(e){}})();true;`;
    try {
      view.injectJavaScript(script);
    } catch {
      // swallow — nothing to do if the view rejected the call
    }
  };

  const respond = (
    id: string,
    type: string,
    ok: boolean,
    payload?: unknown,
    error?: string,
  ): void => {
    inject({ v: PROTOCOL_VERSION, id, type, payload, ok, error });
  };

  return {
    registerHandler(type, handler) {
      handlers.set(type, handler);
    },
    unregisterHandler(type) {
      handlers.delete(type);
    },
    emit(type, payload) {
      inject({ v: PROTOCOL_VERSION, type, payload });
    },
    async handleIncoming(raw) {
      let env: Envelope | null = null;
      try {
        const parsed = JSON.parse(raw) as Partial<Envelope> | null;
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.v === PROTOCOL_VERSION &&
          typeof parsed.type === 'string'
        ) {
          env = parsed as Envelope;
        }
      } catch {
        return; // not a bridge envelope, caller may handle as legacy
      }
      if (!env) return;

      const handler = handlers.get(env.type);
      if (!handler) {
        if (env.id) {
          respond(env.id, env.type, false, undefined, `no handler registered for "${env.type}"`);
        }
        return;
      }

      try {
        const result = await handler(env.payload);
        if (env.id) respond(env.id, env.type, true, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (env.id) respond(env.id, env.type, false, undefined, message);
      }
    },
  };
}

export function isBridgeEnvelope(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    return Boolean(
      parsed &&
        typeof parsed === 'object' &&
        parsed.v === PROTOCOL_VERSION &&
        typeof parsed.type === 'string',
    );
  } catch {
    return false;
  }
}
