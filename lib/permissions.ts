import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { AppState, Linking, Platform } from 'react-native';

export type PermissionKind =
  | 'notifications'
  | 'location'
  | 'camera'
  | 'gallery';
export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'blocked';

export type PermissionsStatus = {
  notifications: PermissionState;
  location: PermissionState;
  // "Permitir siempre". Es un permiso aparte del de primer plano y es el que
  // decide si el rastreo sobrevive a minimizar la app: sin el, Android arma el
  // servicio igual pero deja de entregar posiciones apenas la app deja de
  // verse. Se informa por separado porque hasta ahora nadie podia saber si un
  // conductor lo tenia o no.
  locationBackground: PermissionState;
  camera: PermissionState;
  gallery: PermissionState;
};

type ExpoPermLike = {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain?: boolean;
};

function normalize(res: ExpoPermLike): PermissionState {
  if (res.status === 'granted') return 'granted';
  if (res.status === 'undetermined') return 'undetermined';
  return res.canAskAgain ? 'denied' : 'blocked';
}

export async function getPermissionState(kind: PermissionKind): Promise<PermissionState> {
  if (kind === 'notifications') {
    return normalize(await Notifications.getPermissionsAsync());
  }
  if (kind === 'location') {
    return normalize(await Location.getForegroundPermissionsAsync());
  }
  if (kind === 'camera') {
    return normalize(await ImagePicker.getCameraPermissionsAsync());
  }
  // gallery
  return normalize(await ImagePicker.getMediaLibraryPermissionsAsync());
}

export async function getPermissionsStatus(): Promise<PermissionsStatus> {
  const [notifications, location, locationBackground, camera, gallery] = await Promise.all([
    getPermissionState('notifications'),
    getPermissionState('location'),
    getBackgroundLocationState().catch(() => 'undetermined' as PermissionState),
    getPermissionState('camera'),
    getPermissionState('gallery'),
  ]);
  return { notifications, location, locationBackground, camera, gallery };
}

const pendingRequests = new Map<PermissionKind, Promise<PermissionState>>();

export function requestPermission(kind: PermissionKind): Promise<PermissionState> {
  const pending = pendingRequests.get(kind);
  if (pending) return pending;
  const request = requestPermissionOnce(kind).finally(() => pendingRequests.delete(kind));
  pendingRequests.set(kind, request);
  return request;
}

async function requestPermissionOnce(kind: PermissionKind): Promise<PermissionState> {
  const current = await getPermissionState(kind);
  if (current === 'granted' || current === 'blocked') return current;

  if (kind === 'notifications') {
    return normalize(await Notifications.requestPermissionsAsync());
  }
  if (kind === 'location') {
    return normalize(await Location.requestForegroundPermissionsAsync());
  }
  if (kind === 'camera') {
    return normalize(await ImagePicker.requestCameraPermissionsAsync());
  }
  // gallery
  return normalize(await ImagePicker.requestMediaLibraryPermissionsAsync());
}

// Background location is a separate, OS-level upgrade on top of the foreground
// permission. Caller must ensure foreground is granted first.
export async function getBackgroundLocationState(): Promise<PermissionState> {
  return normalize(await Location.getBackgroundPermissionsAsync());
}

// Ojo con Android 11+ (API 30): el sistema NO permite conceder
// ACCESS_BACKGROUND_LOCATION desde un dialogo dentro de la app. La llamada
// vuelve 'denied' o 'blocked' sin mostrar nada util, y la unica via real es
// que la persona entre a Ajustes y elija "Permitir todo el tiempo". Por eso
// quien llame a esto tiene que MIRAR el resultado y ofrecer openSystemSettings()
// cuando no sea 'granted', en vez de seguir de largo: si se ignora, el rastreo
// arranca, muestra su notificacion y no manda un solo punto al minimizar.
export async function requestBackgroundLocation(): Promise<PermissionState> {
  const current = await getBackgroundLocationState();
  if (current === 'granted' || current === 'blocked') return current;
  return normalize(await Location.requestBackgroundPermissionsAsync());
}

export async function openSystemSettings(): Promise<void> {
  if (Platform.OS === 'ios') {
    await Linking.openURL('app-settings:');
  } else {
    await Linking.openSettings();
  }
}

// Linking resolves when Settings opens, before the user changes permission.
// Subscribe first, and wait for an actual background -> active round trip.
// "inactive" alone can be an iOS permission alert, not a visit to Settings.
export function openSystemSettingsAndWaitForReturn(): Promise<void> {
  return new Promise((resolve, reject) => {
    let leftApp = false;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') leftApp = true;
      if (leftApp && state === 'active') {
        subscription.remove();
        resolve();
      }
    });
    openSystemSettings().catch((error) => {
      subscription.remove();
      reject(error);
    });
  });
}
