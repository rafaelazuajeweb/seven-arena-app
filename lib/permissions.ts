import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import { Linking, Platform } from 'react-native';

export type PermissionKind = 'notifications' | 'location';
export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'blocked';

export type PermissionsStatus = {
  notifications: PermissionState;
  location: PermissionState;
};

export async function getPermissionState(kind: PermissionKind): Promise<PermissionState> {
  if (kind === 'notifications') {
    const res = await Notifications.getPermissionsAsync();
    if (res.status === 'granted') return 'granted';
    if (res.status === 'undetermined') return 'undetermined';
    return res.canAskAgain ? 'denied' : 'blocked';
  }
  const res = await Location.getForegroundPermissionsAsync();
  if (res.status === 'granted') return 'granted';
  if (res.status === 'undetermined') return 'undetermined';
  return res.canAskAgain ? 'denied' : 'blocked';
}

export async function getPermissionsStatus(): Promise<PermissionsStatus> {
  const [notifications, location] = await Promise.all([
    getPermissionState('notifications'),
    getPermissionState('location'),
  ]);
  return { notifications, location };
}

export async function requestPermission(kind: PermissionKind): Promise<PermissionState> {
  const current = await getPermissionState(kind);
  if (current === 'granted' || current === 'blocked') return current;

  if (kind === 'notifications') {
    const res = await Notifications.requestPermissionsAsync();
    if (res.status === 'granted') return 'granted';
    return res.canAskAgain ? 'denied' : 'blocked';
  }

  const res = await Location.requestForegroundPermissionsAsync();
  if (res.status === 'granted') return 'granted';
  return res.canAskAgain ? 'denied' : 'blocked';
}

export async function openSystemSettings(): Promise<void> {
  if (Platform.OS === 'ios') {
    await Linking.openURL('app-settings:');
  } else {
    await Linking.openSettings();
  }
}
