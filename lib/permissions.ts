import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { Linking, Platform } from 'react-native';

export type PermissionKind =
  | 'notifications'
  | 'location'
  | 'camera'
  | 'gallery';
export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'blocked';

export type PermissionsStatus = {
  notifications: PermissionState;
  location: PermissionState;
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
  const [notifications, location, camera, gallery] = await Promise.all([
    getPermissionState('notifications'),
    getPermissionState('location'),
    getPermissionState('camera'),
    getPermissionState('gallery'),
  ]);
  return { notifications, location, camera, gallery };
}

export async function requestPermission(kind: PermissionKind): Promise<PermissionState> {
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
