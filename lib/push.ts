import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

export type PushTokenInfo = {
  token: string;
  platform: 'ios' | 'android';
};

let cached: PushTokenInfo | null = null;

const getProjectId = (): string | undefined => {
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  if (fromExtra) return fromExtra;
  // Fallback when EAS hasn't been linked yet — getExpoPushTokenAsync will use the slug heuristic.
  return undefined;
};

/**
 * Devuelve el Expo push token del dispositivo, o null si no hay permiso o el
 * device no soporta push (simuladores, web, etc.). No lanza excepciones para
 * no romper el flujo si el usuario aún no concedió el permiso.
 */
export async function getExpoPushToken(): Promise<PushTokenInfo | null> {
  if (cached) return cached;

  const perm = await Notifications.getPermissionsAsync();
  if (perm.status !== 'granted') return null;

  try {
    const projectId = getProjectId();
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (!result?.data) return null;
    cached = {
      token: result.data,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    };
    return cached;
  } catch (err) {
    if (__DEV__) {
      console.warn('[push] getExpoPushTokenAsync failed:', err);
    }
    return null;
  }
}

export function clearCachedPushToken(): void {
  cached = null;
}
