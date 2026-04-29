import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

type Mode = 'hidden' | 'offline' | 'restored';

const RESTORED_DURATION_MS = 2500;
const SLIDE_MS = 220;

function isOnline(state: NetInfoState): boolean {
  if (state.isConnected === false) return false;
  // isInternetReachable can be null while NetInfo is probing — treat null as online
  // to avoid false offline banners on cold start.
  if (state.isInternetReachable === false) return false;
  return true;
}

export default function NetworkBanner() {
  const [mode, setMode] = useState<Mode>('hidden');
  const slideY = useRef(new Animated.Value(-80)).current;
  const wasOfflineRef = useRef(false);
  const restoredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const animateTo = (target: Mode) => {
      const toValue = target === 'hidden' ? -80 : 0;
      Animated.timing(slideY, {
        toValue,
        duration: SLIDE_MS,
        useNativeDriver: true,
      }).start();
    };

    const apply = (state: NetInfoState) => {
      const online = isOnline(state);

      if (!online) {
        if (restoredTimerRef.current) {
          clearTimeout(restoredTimerRef.current);
          restoredTimerRef.current = null;
        }
        wasOfflineRef.current = true;
        setMode('offline');
        animateTo('offline');
        return;
      }

      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        setMode('restored');
        animateTo('restored');
        if (restoredTimerRef.current) clearTimeout(restoredTimerRef.current);
        restoredTimerRef.current = setTimeout(() => {
          animateTo('hidden');
          setTimeout(() => setMode('hidden'), SLIDE_MS);
        }, RESTORED_DURATION_MS);
      }
    };

    NetInfo.fetch().then(apply).catch(() => {});
    const unsubscribe = NetInfo.addEventListener(apply);

    return () => {
      unsubscribe();
      if (restoredTimerRef.current) clearTimeout(restoredTimerRef.current);
    };
  }, [slideY]);

  if (mode === 'hidden') return null;

  const isOffline = mode === 'offline';

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        isOffline ? styles.offline : styles.restored,
        { transform: [{ translateY: slideY }] },
      ]}
    >
      <View style={styles.dot} />
      <Text style={styles.text}>
        {isOffline ? 'Sin conexión a internet' : 'Conexión restaurada'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 12,
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
  },
  offline: { backgroundColor: '#DC2626' },
  restored: { backgroundColor: '#15B09A' },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.95)',
    marginRight: 10,
  },
  text: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
