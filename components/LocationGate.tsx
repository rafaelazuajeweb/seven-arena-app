import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getPermissionState,
  openSystemSettings,
  requestPermission,
  type PermissionState,
} from '../lib/permissions';

type Props = {
  onGranted: () => void;
};

const ACCENT = '#34F3C6';
const BG = '#0e1822';

export default function LocationGate({ onGranted }: Props) {
  const [state, setState] = useState<PermissionState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getPermissionState('location');
    setState(next);
    if (next === 'granted') onGranted();
  }, [onGranted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const handlePress = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (state === 'blocked') {
        await openSystemSettings();
      } else {
        const result = await requestPermission('location');
        setState(result);
        if (result === 'granted') onGranted();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, state, onGranted]);

  if (state === null) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color={ACCENT} />
      </SafeAreaView>
    );
  }

  const blocked = state === 'blocked';
  const buttonLabel = blocked ? 'Abrir ajustes' : 'Activar ubicación';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Image
          source={require('../assets/images/splash-icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <View style={styles.iconBubble}>
          <Text style={styles.iconText}>📍</Text>
        </View>
        <Text style={styles.title}>Activá tu ubicación</Text>
        <Text style={styles.subtitle}>
          Seven Arena necesita acceso al GPS para mostrarte rutas, traslados
          cercanos y coordinar tus viajes.
        </Text>
        {blocked ? (
          <Text style={styles.hint}>
            El permiso está bloqueado. Abrí Ajustes y habilitalo manualmente
            para continuar.
          </Text>
        ) : (
          <Text style={styles.hint}>
            Sin este permiso no podés continuar. Podés modificarlo cuando
            quieras desde Ajustes.
          </Text>
        )}
      </View>

      <View style={styles.footer}>
        <Pressable
          onPress={handlePress}
          disabled={busy}
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
        >
          {busy ? (
            <ActivityIndicator color="#0d1b3e" size="small" />
          ) : (
            <Text style={styles.btnLabel}>{buttonLabel}</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  logo: { width: 180, height: 80, marginBottom: 8 },
  iconBubble: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(52,243,198,0.12)',
    borderColor: 'rgba(52,243,198,0.35)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  iconText: { fontSize: 44 },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f1f5f9',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14.5,
    lineHeight: 21,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
  },
  hint: {
    fontSize: 12.5,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    marginTop: 4,
  },
  footer: { paddingHorizontal: 24, paddingBottom: 28, paddingTop: 12 },
  btn: {
    height: 52,
    borderRadius: 14,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnLabel: { color: '#0d1b3e', fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
