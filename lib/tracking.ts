import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// Background task identifier — must match the string used in
// Location.startLocationUpdatesAsync() and in TaskManager.defineTask().
export const LOCATION_TRACKING_TASK = 'seven-location-tracking';

const SESSION_STORAGE_KEY = 'seven.session';
const TRACKING_ENABLED_KEY = 'seven.tracking.enabled';

// 3-second cadence as requested by the client.
const UPDATE_INTERVAL_MS = 3000;
const MIN_DISTANCE_M = 0;

type StoredSession = {
  kind?: string;
  role?: string;
  driverId?: string;
  athleteId?: string;
  user?: Record<string, unknown>;
};

const getApiUrl = (): string | null => {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const fromExtra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl?.trim();
  if (fromExtra) return fromExtra.replace(/\/+$/, '');
  return null;
};

const getStoredDriverId = async (): Promise<string | null> => {
  try {
    const raw = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.kind === 'driver' && parsed.driverId) return parsed.driverId;
    return null;
  } catch {
    return null;
  }
};

// Tracks the result of the most recent fetch so the UI can show what's
// happening — silent failures on cellular are otherwise invisible.
export type PushState = {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
};
let lastPushState: PushState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastStatus: null,
  lastError: null,
};
export const getLastPushState = (): PushState => ({ ...lastPushState });

// Posts a single location to the backend. Errors are captured into
// lastPushState so the toggle can surface them (carrier timeouts, DNS
// failures, 4xx responses) instead of pretending everything is fine.
const pushPosition = async (location: Location.LocationObject): Promise<boolean> => {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    lastPushState = {
      ...lastPushState,
      lastAttemptAt: Date.now(),
      lastError: 'EXPO_PUBLIC_API_URL no configurada',
      lastStatus: null,
    };
    return false;
  }
  const driverId = await getStoredDriverId();
  if (!driverId) {
    lastPushState = {
      ...lastPushState,
      lastAttemptAt: Date.now(),
      lastError: 'driverId ausente en la sesión',
      lastStatus: null,
    };
    return false;
  }
  const body = {
    driverId,
    timestamp: new Date(location.timestamp || Date.now()).toISOString(),
    location: {
      type: 'Point',
      coordinates: [location.coords.longitude, location.coords.latitude],
    },
    speed:
      typeof location.coords.speed === 'number' && location.coords.speed >= 0
        ? location.coords.speed
        : undefined,
    heading:
      typeof location.coords.heading === 'number' && location.coords.heading >= 0
        ? location.coords.heading
        : undefined,
  };

  // Explicit timeout — without it, fetch on a stuck cellular radio can hang
  // indefinitely and block the next tick.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  lastPushState = { ...lastPushState, lastAttemptAt: Date.now() };
  try {
    const res = await fetch(`${apiUrl}/vehicle-positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      lastPushState = {
        ...lastPushState,
        lastStatus: res.status,
        lastError: `HTTP ${res.status}`,
      };
      return false;
    }
    lastPushState = {
      ...lastPushState,
      lastSuccessAt: Date.now(),
      lastStatus: res.status,
      lastError: null,
    };
    return true;
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'timeout (10s)'
          : err.message
        : 'fetch falló';
    lastPushState = { ...lastPushState, lastError: msg, lastStatus: null };
    return false;
  } finally {
    clearTimeout(timer);
  }
};

// Defining the task at module load is required by TaskManager: it has to be
// registered before app launch completes so the OS can revive it.
if (!TaskManager.isTaskDefined(LOCATION_TRACKING_TASK)) {
  TaskManager.defineTask(LOCATION_TRACKING_TASK, async ({ data, error }) => {
    if (error) return;
    const payload = data as { locations?: Location.LocationObject[] } | undefined;
    const locations = payload?.locations;
    if (!locations || locations.length === 0) return;
    // Push each fresh fix individually so the admin sees a flowing trail.
    for (const loc of locations) {
      await pushPosition(loc);
    }
  });
}

// Hardware-level check: are the OS location services (GPS / Wi-Fi / Cell)
// actually turned on? This is independent of whether the user granted the
// app permission — both have to be true to get a fix.
export const areGpsServicesEnabled = async (): Promise<boolean> => {
  try {
    return await Location.hasServicesEnabledAsync();
  } catch {
    return false;
  }
};

// Prompt the user to enable location services without leaving the app.
// Android: shows the system "Use location?" dialog (Google Play services).
// iOS: no equivalent — must go to Settings, so we just report current state.
export const ensureGpsServicesEnabled = async (): Promise<boolean> => {
  if (await areGpsServicesEnabled()) return true;
  if (Platform.OS === 'android') {
    try {
      await Location.enableNetworkProviderAsync();
    } catch {
      // User cancelled the dialog or the device has no Google Play services.
      return false;
    }
    return await areGpsServicesEnabled();
  }
  return false;
};

// Writes a driver session to AsyncStorage so the background TaskManager
// (which can't be passed a driverId directly) can find it on every fix.
export const setDriverSession = async (driverId: string): Promise<void> => {
  const payload = { kind: 'driver', driverId };
  await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
};

// One-shot: fetch the device's current position and POST it. Used by the
// manual "Activar GPS" toggle so the admin sees the driver immediately,
// without waiting for the next TaskManager tick.
export const pushCurrentPositionNow = async (): Promise<boolean> => {
  if (!(await areGpsServicesEnabled())) return false;
  try {
    const last = await Location.getLastKnownPositionAsync();
    const loc =
      last ??
      (await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      }));
    if (!loc) return false;
    await pushPosition(loc);
    return true;
  } catch {
    return false;
  }
};

export const isTrackingRunning = async (): Promise<boolean> => {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TRACKING_TASK);
  } catch {
    return false;
  }
};

export const startTracking = async (): Promise<boolean> => {
  // Avoid spinning a second instance if one is already running.
  if (await isTrackingRunning()) {
    await AsyncStorage.setItem(TRACKING_ENABLED_KEY, '1');
    return true;
  }
  // Foreground is the prerequisite; background is best-effort.
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  // No point arming the task if the device's GPS is physically off — we'd
  // just sit idle without any fixes and the UI would lie about being "live".
  if (!(await areGpsServicesEnabled())) return false;

  try {
    await Location.startLocationUpdatesAsync(LOCATION_TRACKING_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: UPDATE_INTERVAL_MS,
      distanceInterval: MIN_DISTANCE_M,
      // Background-only on Android — keeps the task alive when minimized.
      foregroundService: {
        notificationTitle: 'Seven Arena · tracking activo',
        notificationBody: 'Registrando ubicación para tus traslados.',
        notificationColor: '#21D0B3',
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.AutomotiveNavigation,
    });
    await AsyncStorage.setItem(TRACKING_ENABLED_KEY, '1');
    return true;
  } catch {
    return false;
  }
};

export const stopTracking = async (): Promise<void> => {
  await AsyncStorage.removeItem(TRACKING_ENABLED_KEY);
  if (await isTrackingRunning()) {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TRACKING_TASK);
    } catch {
      // Already stopped or task crashed — nothing to do.
    }
  }
};

// Called on app boot. If the user previously had tracking enabled and is
// still logged in as driver with location permission, resume automatically.
export const resumeTrackingIfEnabled = async (): Promise<void> => {
  const enabled = await AsyncStorage.getItem(TRACKING_ENABLED_KEY);
  if (!enabled) return;
  const driverId = await getStoredDriverId();
  if (!driverId) {
    await stopTracking();
    return;
  }
  await startTracking();
};
