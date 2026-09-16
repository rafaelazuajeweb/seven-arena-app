import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import SplashOverlay from '../components/SplashOverlay';
import NetworkBanner from '../components/NetworkBanner';
import OnboardingScreen from '../components/OnboardingScreen';
import BackgroundLocationDisclosure from '../components/BackgroundLocationDisclosure';
import { createNativeBridge, isBridgeEnvelope, type NativeBridge } from '../lib/native-bridge';
import {
  getBackgroundLocationState,
  getPermissionsStatus,
  openSystemSettings,
  requestBackgroundLocation,
  requestPermission,
  type PermissionKind,
  type PermissionState,
} from '../lib/permissions';
import { getExpoPushToken } from '../lib/push';
import {
  areGpsServicesEnabled,
  ensureGpsServicesEnabled,
  getLastPushState,
  isTrackingRunning,
  pushCurrentPositionNow,
  resumeTrackingIfEnabled,
  setDriverSession,
  startTracking,
  stopTracking,
} from '../lib/tracking';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'default',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#34F3C6',
  }).catch(() => {});
}

SplashScreen.preventAutoHideAsync().catch(() => {});

const SESSION_STORAGE_KEY = 'seven.session';
const ONBOARDED_KEY = 'seven.onboarded';
const SPLASH_MIN_DURATION_MS = 900;

const getWebUrl = (): string | null => {
  const fromEnv = process.env.EXPO_PUBLIC_WEB_URL?.trim();
  if (fromEnv) return fromEnv;
  const fromExtra = (Constants.expoConfig?.extra as { webUrl?: string } | undefined)?.webUrl?.trim();
  if (fromExtra) return fromExtra;
  return null;
};

type IncomingMessage =
  | { kind: 'admin'; role: 'ADMIN'; user?: Record<string, unknown> }
  | {
      kind: 'athlete';
      role: 'ATHLETE';
      athleteId: string;
      profile: { id: string; fullName: string; email: string | null };
    }
  | {
      kind: 'driver';
      role: 'DRIVER';
      driverId: string;
      profile: { id: string; fullName: string; email: string | null };
    };

const INJECTED_BEFORE_LOAD = `
  window.__seven_native = true;
  true;
`;

export default function Home() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [splashVisible, setSplashVisible] = useState(true);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const mountedAt = useRef(Date.now());
  const nativeSplashHidden = useRef(false);
  const webViewRef = useRef<WebView | null>(null);
  const bridgeRef = useRef<NativeBridge | null>(null);

  // Google Play exige un aviso propio de la app antes del diálogo del sistema
  // que pide ubicación en segundo plano. Los handlers del bridge son funciones
  // async que corren fuera del árbol de React, así que no pueden "renderizar y
  // esperar": guardamos el `resolve` de una promesa en un ref y el modal lo
  // invoca cuando el usuario responde. Los useCallback van con deps [] a
  // propósito — los handlers se registran una sola vez y capturan estas
  // referencias para siempre.
  const [bgDisclosureVisible, setBgDisclosureVisible] = useState(false);
  const [bgDisclosureStep, setBgDisclosureStep] = useState<'disclosure' | 'settings'>('disclosure');
  const bgDisclosureResolver = useRef<((accepted: boolean) => void) | null>(null);

  const askBackgroundDisclosure = useCallback(
    (step: 'disclosure' | 'settings') =>
      new Promise<boolean>((resolve) => {
        // Si ya había un aviso en curso (p.ej. auth.session y tracking.start
        // llegan solapados), lo cancelamos en vez de pisar su resolver: una
        // promesa huérfana dejaría al handler del bridge esperando para
        // siempre y la web nunca recibiría respuesta.
        bgDisclosureResolver.current?.(false);
        bgDisclosureResolver.current = resolve;
        setBgDisclosureStep(step);
        setBgDisclosureVisible(true);
      }),
    [],
  );

  const resolveBgDisclosure = useCallback((accepted: boolean) => {
    setBgDisclosureVisible(false);
    const resolve = bgDisclosureResolver.current;
    bgDisclosureResolver.current = null;
    resolve?.(accepted);
  }, []);

  useEffect(
    () => () => {
      bgDisclosureResolver.current?.(false);
      bgDisclosureResolver.current = null;
    },
    [],
  );

  const requestBackgroundWithDisclosure = useCallback(async (): Promise<PermissionState> => {
    const current = await getBackgroundLocationState();
    if (current === 'granted') return 'granted';

    const accepted = await askBackgroundDisclosure('disclosure');
    if (!accepted) return 'denied';

    const result = await requestBackgroundLocation();
    if (result === 'granted') return result;

    // Android 11+ (API 30) no concede ACCESS_BACKGROUND_LOCATION desde un
    // diálogo: el sistema obliga a elegir "Permitir todo el tiempo" a mano en
    // los ajustes de la app. Sin este segundo paso el permiso no se otorga
    // nunca, que es justo lo que pasaba antes — en silencio, por el
    // `.catch(() => undefined)` que había aquí.
    if (Platform.OS === 'android' && Number(Platform.Version) >= 30) {
      const goToSettings = await askBackgroundDisclosure('settings');
      if (goToSettings) await openSystemSettings().catch(() => undefined);
      return getBackgroundLocationState();
    }
    return result;
  }, [askBackgroundDisclosure]);

  // ─── PUNTO DE DECISIÓN PENDIENTE ──────────────────────────────────────────
  // Qué hacer cuando el conductor NO concede ubicación en segundo plano.
  // Hoy esto replica el comportamiento anterior: el turno arranca igual y el
  // tracking queda solo en primer plano (se corta al minimizar la app), sin
  // que nadie se entere. Es la opción permisiva.
  //
  // Alternativas y su costo:
  //  - Bloquear el turno hasta que conceda: la central nunca pierde el rastro,
  //    pero un conductor sin el permiso no puede trabajar.
  //  - Notificar a la central que ese turno va sin cobertura en segundo plano:
  //    hace falta un endpoint nuevo y decidir qué hace la central con el aviso.
  //  - Avisar solo al conductor y dejarlo seguir: barato, pero la central
  //    sigue a ciegas.
  const handleBackgroundPermissionOutcome = useCallback(async (state: PermissionState) => {
    if (state === 'granted') return;
    // TODO(rafael): política de degradación. Ver la nota de arriba.
  }, []);

  if (bridgeRef.current === null) {
    const bridge = createNativeBridge(webViewRef);
    bridge.registerHandler('auth.session', async (payload) => {
      await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
      const kind = (payload as { kind?: unknown } | undefined)?.kind;
      if (kind === 'driver') {
        // Pide el permiso de segundo plano precedido del aviso que exige
        // Play. Si el conductor lo rechaza, el tracking en primer plano sigue
        // funcionando mientras tenga el WebView abierto.
        const bgState = await requestBackgroundWithDisclosure().catch(
          () => 'denied' as PermissionState,
        );
        await handleBackgroundPermissionOutcome(bgState);
        await startTracking().catch(() => undefined);
      } else {
        await stopTracking().catch(() => undefined);
      }
      return { saved: true };
    });
    bridge.registerHandler('auth.logout', async () => {
      await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
      await stopTracking().catch(() => undefined);
      return { ok: true };
    });
    // Manual GPS-on for the demo: web tells us who the driver is, we persist
    // the session, request both permission levels, push one fix right away
    // and start the continuous task.
    bridge.registerHandler('tracking.start', async (payload) => {
      const driverId = (payload as { driverId?: unknown } | undefined)?.driverId;
      if (typeof driverId !== 'string' || !driverId) {
        throw new Error('driverId requerido');
      }
      await setDriverSession(driverId);
      const fg = await requestPermission('location');
      if (fg !== 'granted') {
        return {
          ok: false,
          foreground: fg,
          background: 'undetermined',
          gpsServices: await areGpsServicesEnabled(),
          running: false,
        };
      }
      // Ask the system to turn on location services if they're off — this
      // shows the in-app prompt on Android so the driver doesn't have to
      // dig into Ajustes.
      const gpsServices = await ensureGpsServicesEnabled();
      if (!gpsServices) {
        return {
          ok: false,
          foreground: fg,
          background: 'undetermined',
          gpsServices: false,
          running: false,
        };
      }
      const bg = await requestBackgroundWithDisclosure().catch(
        () => 'denied' as PermissionState,
      );
      await handleBackgroundPermissionOutcome(bg);
      const immediate = await pushCurrentPositionNow();
      const started = await startTracking();
      return {
        ok: started,
        foreground: fg,
        background: bg,
        gpsServices: true,
        immediate,
        running: started,
      };
    });
    bridge.registerHandler('tracking.stop', async () => {
      await stopTracking();
      return { ok: true, running: false };
    });
    bridge.registerHandler('tracking.status', async () => {
      const running = await isTrackingRunning();
      const gpsServices = await areGpsServicesEnabled();
      return { running, gpsServices, lastPush: getLastPushState() };
    });
    bridge.registerHandler('permissions.status', async () => {
      return await getPermissionsStatus();
    });
    bridge.registerHandler('permissions.request', async (payload) => {
      const kind = (payload as { kind?: unknown } | undefined)?.kind;
      if (
        kind !== 'notifications' &&
        kind !== 'location' &&
        kind !== 'camera' &&
        kind !== 'gallery'
      ) {
        throw new Error(
          'kind debe ser "notifications", "location", "camera" o "gallery"',
        );
      }
      const state = await requestPermission(kind as PermissionKind);
      return { kind, state };
    });
    bridge.registerHandler('device.open-settings', async () => {
      await openSystemSettings();
      return { opened: true };
    });
    // Abre una URL en el sistema (marcador de teléfono, SMS, correo, enlaces
    // externos). El WebView no maneja tel:/sms:/mailto: por sí mismo, así que
    // el lado web (p.ej. EmergencyNumbersSection y los botones de llamada)
    // envía `url.open` y aquí lo derivamos al SO con Linking. Se restringe a
    // esquemas seguros para no abrir deep links arbitrarios si el frontend
    // llegara a verse comprometido.
    bridge.registerHandler('url.open', async (payload) => {
      const url = (payload as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string' || !url) {
        throw new Error('url requerida');
      }
      if (!/^(tel:|sms:|mailto:|https:|whatsapp:)/i.test(url)) {
        throw new Error('esquema de URL no permitido');
      }
      await Linking.openURL(url);
      return { opened: true };
    });
    bridge.registerHandler('push.token', async () => {
      const info = await getExpoPushToken();
      if (!info) {
        const err = new Error('No hay token de push disponible');
        (err as Error & { code?: string }).code = 'NO_TOKEN';
        throw err;
      }
      return info;
    });
    bridge.registerHandler('location.current', async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        const err = new Error(
          perm.canAskAgain
            ? 'Permiso de ubicación no concedido'
            : 'Permiso de ubicación bloqueado en Ajustes',
        );
        (err as Error & { code?: string }).code = perm.canAskAgain
          ? 'PERMISSION_DENIED'
          : 'PERMISSION_BLOCKED';
        throw err;
      }
      const last = await Location.getLastKnownPositionAsync();
      const pos =
        last ??
        (await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        }));
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: pos.timestamp,
      };
    });
    bridgeRef.current = bridge;
  }

  const startUrl = useMemo(() => {
    const base = getWebUrl();
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/m/login`;
  }, []);

  const hideNativeSplash = useCallback(() => {
    if (nativeSplashHidden.current) return;
    nativeSplashHidden.current = true;
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  const dismissSplash = useCallback(() => {
    const elapsed = Date.now() - mountedAt.current;
    const wait = Math.max(0, SPLASH_MIN_DURATION_MS - elapsed);
    setTimeout(() => {
      hideNativeSplash();
      setSplashVisible(false);
    }, wait);
  }, [hideNativeSplash]);

  // Safety net: if the WebView never reports loadEnd (e.g. blocked by error),
  // dismiss the splash anyway after a generous timeout.
  useEffect(() => {
    const timer = setTimeout(() => {
      hideNativeSplash();
      setSplashVisible(false);
    }, 8000);
    return () => clearTimeout(timer);
  }, [hideNativeSplash]);

  // Forward notification taps to the web side. Covers two cases:
  //  1) tap while the app is open / backgrounded → addNotificationResponseReceivedListener
  //  2) tap from a fully-killed app → getLastNotificationResponseAsync on boot
  // The web side subscribes via bridge.on("push.tap", ...) and decides routing.
  useEffect(() => {
    const emitTap = (data: Record<string, unknown> | undefined) => {
      if (!bridgeRef.current) return;
      bridgeRef.current.emit('push.tap', data ?? {});
    };

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      emitTap(data);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        const data = response.notification.request.content.data as
          | Record<string, unknown>
          | undefined;
        // Defer until the WebView mounts so the bridge can deliver.
        setTimeout(() => emitTap(data), 1500);
      })
      .catch(() => {});

    return () => sub.remove();
  }, []);

  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
    const raw = event.nativeEvent?.data;
    if (!raw) return;

    // Bridge-versioned envelopes route through the dispatcher.
    if (isBridgeEnvelope(raw) && bridgeRef.current) {
      await bridgeRef.current.handleIncoming(raw);
      return;
    }

    // Legacy fire-and-forget session payload from older builds of /m/login.
    try {
      const payload = JSON.parse(raw) as IncomingMessage;
      if (payload && typeof payload === 'object' && 'kind' in payload) {
        await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
      }
    } catch {
      // not JSON we expect — ignore
    }
  }, []);

  const handleLoadEnd = useCallback(() => {
    dismissSplash();
  }, [dismissSplash]);

  const handleError = useCallback(() => {
    setErrorMessage('No se pudo conectar con el servidor.');
    dismissSplash();
  }, [dismissSplash]);

  const reload = useCallback(() => {
    setErrorMessage(null);
    setSplashVisible(true);
    mountedAt.current = Date.now();
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!startUrl) {
      hideNativeSplash();
    }
  }, [startUrl, hideNativeSplash]);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDED_KEY)
      .then((value) => setOnboardingDone(!!value))
      .catch(() => setOnboardingDone(true));
  }, []);

  // If the app was killed while a driver session + tracking were active,
  // pick up where we left off so the GPS trail doesn't break.
  useEffect(() => {
    resumeTrackingIfEnabled().catch(() => undefined);
  }, []);

  // Watch GPS hardware on/off + push results while the app is in foreground
  // and notify the web side so the toggle UI reflects reality (driver
  // disabled GPS from the notification shade, network outage, etc).
  useEffect(() => {
    let lastEmittedAttemptAt: number | null = null;
    let lastEmitted: { running: boolean; gpsServices: boolean } | null = null;
    const tick = async () => {
      try {
        const running = await isTrackingRunning();
        const gpsServices = await areGpsServicesEnabled();
        const lastPush = getLastPushState();
        const stateChanged =
          !lastEmitted ||
          lastEmitted.running !== running ||
          lastEmitted.gpsServices !== gpsServices;
        const pushChanged = lastPush.lastAttemptAt !== lastEmittedAttemptAt;
        if (stateChanged || pushChanged) {
          lastEmitted = { running, gpsServices };
          lastEmittedAttemptAt = lastPush.lastAttemptAt;
          bridgeRef.current?.emit('tracking.statusChanged', {
            running,
            gpsServices,
            lastPush,
          });
        }
      } catch {
        // Best-effort — next tick will retry.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 3000);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void tick();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, []);

  const finishOnboarding = useCallback(() => {
    AsyncStorage.setItem(ONBOARDED_KEY, '1').catch(() => {});
    setOnboardingDone(true);
  }, []);

  if (!startUrl) {
    return (
      <SafeAreaView style={styles.errorContainer}>
        <View style={styles.errorContent}>
          <Text style={styles.errorTitle}>Configuración faltante</Text>
          <Text style={styles.errorBody}>
            Define EXPO_PUBLIC_WEB_URL en .env y reinicia el servidor de Expo.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (errorMessage) {
    return (
      <SafeAreaView style={styles.errorContainer}>
        <ScrollView
          contentContainerStyle={styles.errorContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor="#34F3C6" />}
        >
          <Text style={styles.errorTitle}>Sin conexión</Text>
          <Text style={styles.errorBody}>{errorMessage}</Text>
          <Text style={styles.errorHint}>Desliza hacia abajo para reintentar.</Text>
        </ScrollView>
        <NetworkBanner />
      </SafeAreaView>
    );
  }

  if (onboardingDone === false) {
    hideNativeSplash();
    return <OnboardingScreen onDone={finishOnboarding} />;
  }

  // Aquí había una barrera que impedía entrar sin permiso de ubicación.
  // Apple rechazó la 1.0.1 (4) por Guideline 5.1.5: la app debe ser
  // plenamente funcional con los Servicios de Ubicación desactivados.
  //
  // La ubicación es exclusiva del rol Conductor y se solicita en su propio
  // flujo, al pulsar "Activar GPS y enviar ubicación" en el portal, con su
  // aviso previo. Un participante que consulta su credencial, su horario o
  // sus traslados no necesita conceder nada. No reintroducir la barrera.
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.webContainer}>
        <WebView
          key={refreshKey}
          ref={webViewRef}
          source={{ uri: startUrl }}
          onMessage={handleMessage}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          onHttpError={handleError}
          injectedJavaScriptBeforeContentLoaded={INJECTED_BEFORE_LOAD}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsBackForwardNavigationGestures
          originWhitelist={['*']}
          setSupportMultipleWindows={false}
          pullToRefreshEnabled
          startInLoadingState={false}
          style={styles.webView}
        />
        <SplashOverlay visible={splashVisible} />
        <NetworkBanner />
      </View>
      <BackgroundLocationDisclosure
        visible={bgDisclosureVisible}
        step={bgDisclosureStep}
        onAccept={() => resolveBgDisclosure(true)}
        onDecline={() => resolveBgDisclosure(false)}
        onOpenSettings={() => resolveBgDisclosure(true)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1822' },
  webContainer: { flex: 1, position: 'relative' },
  webView: { flex: 1, backgroundColor: '#0e1822' },
  errorContainer: { flex: 1, backgroundColor: '#0e1822' },
  errorContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  errorTitle: {
    color: '#f1f5f9',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  errorBody: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 8,
  },
  errorHint: { color: '#34F3C6', fontSize: 13 },
});
