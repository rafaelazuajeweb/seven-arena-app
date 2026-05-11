import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
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
import LocationGate from '../components/LocationGate';
import { createNativeBridge, isBridgeEnvelope, type NativeBridge } from '../lib/native-bridge';
import {
  getPermissionState,
  getPermissionsStatus,
  openSystemSettings,
  requestBackgroundLocation,
  requestPermission,
  type PermissionKind,
} from '../lib/permissions';
import { getExpoPushToken } from '../lib/push';
import {
  resumeTrackingIfEnabled,
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
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const mountedAt = useRef(Date.now());
  const nativeSplashHidden = useRef(false);
  const webViewRef = useRef<WebView | null>(null);
  const bridgeRef = useRef<NativeBridge | null>(null);
  if (bridgeRef.current === null) {
    const bridge = createNativeBridge(webViewRef);
    bridge.registerHandler('auth.session', async (payload) => {
      await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
      const kind = (payload as { kind?: unknown } | undefined)?.kind;
      if (kind === 'driver') {
        // Best-effort: try to upgrade to background permission so tracking
        // survives minimizing the app. If denied, foreground tracking still
        // works while the driver has the WebView open.
        await requestBackgroundLocation().catch(() => undefined);
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

  // Re-check location permission whenever the app comes to foreground so a
  // user that revoked GPS in Ajustes gets gated again before reaching the web.
  useEffect(() => {
    const check = async () => {
      try {
        const state = await getPermissionState('location');
        setLocationGranted(state === 'granted');
      } catch {
        setLocationGranted(false);
      }
    };
    void check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void check();
    });
    return () => sub.remove();
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

  if (locationGranted === false) {
    hideNativeSplash();
    return <LocationGate onGranted={() => setLocationGranted(true)} />;
  }

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
