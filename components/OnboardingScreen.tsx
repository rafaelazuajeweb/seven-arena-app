import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getPermissionsStatus,
  openSystemSettings,
  requestPermission,
  type PermissionKind,
  type PermissionsStatus,
  type PermissionState,
} from '../lib/permissions';

type Props = {
  onDone: () => void;
};

const ACCENT = '#34F3C6';
const BG = '#0e1822';

export default function OnboardingScreen({ onDone }: Props) {
  const [status, setStatus] = useState<PermissionsStatus | null>(null);
  const [busy, setBusy] = useState<PermissionKind | null>(null);

  const refresh = useCallback(async () => {
    const next = await getPermissionsStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handlePress = useCallback(
    async (kind: PermissionKind) => {
      const current = status?.[kind];
      if (current === 'granted' || busy) return;
      setBusy(kind);
      try {
        if (current === 'blocked') {
          await openSystemSettings();
        } else {
          await requestPermission(kind);
        }
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [status, busy, refresh],
  );

  if (!status) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color={ACCENT} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Image
          source={require('../assets/images/splash-icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.title}>Bienvenido a Seven Arena</Text>
        <Text style={styles.subtitle}>
          Para una experiencia completa, activa los siguientes permisos. Puedes
          cambiarlos cuando quieras desde tu perfil.
        </Text>

        <PermissionCard
          icon="🔔"
          title="Notificaciones"
          description="Recibí avisos de cambios en tus traslados y viajes próximos."
          state={status.notifications}
          busy={busy === 'notifications'}
          onPress={() => handlePress('notifications')}
        />

        <PermissionCard
          icon="📍"
          title="Ubicación"
          description="Te mostramos rutas y traslados cercanos a tu posición."
          state={status.location}
          busy={busy === 'location'}
          onPress={() => handlePress('location')}
        />
      </View>

      <View style={styles.footer}>
        <Pressable
          onPress={onDone}
          style={({ pressed }) => [styles.continueBtn, pressed && styles.pressed]}
        >
          <Text style={styles.continueLabel}>Continuar</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function PermissionCard({
  icon,
  title,
  description,
  state,
  busy,
  onPress,
}: {
  icon: string;
  title: string;
  description: string;
  state: PermissionState;
  busy: boolean;
  onPress: () => void;
}) {
  const granted = state === 'granted';
  const blocked = state === 'blocked';
  const buttonLabel = granted
    ? 'Activado'
    : blocked
      ? 'Abrir ajustes'
      : 'Activar';

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardIcon}>{icon}</Text>
        <Text style={styles.cardTitle}>{title}</Text>
      </View>
      <Text style={styles.cardDescription}>{description}</Text>
      <Pressable
        onPress={onPress}
        disabled={granted || busy}
        style={({ pressed }) => [
          styles.cardBtn,
          granted && styles.cardBtnGranted,
          pressed && !granted && styles.pressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={granted ? '#0d1b3e' : '#0d1b3e'} size="small" />
        ) : (
          <Text style={[styles.cardBtnLabel, granted && styles.cardBtnLabelGranted]}>
            {granted ? '✓ ' : ''}
            {buttonLabel}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 32, gap: 16 },
  logo: { width: 200, height: 90, alignSelf: 'center', marginBottom: 12 },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f1f5f9',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    marginBottom: 12,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardIcon: { fontSize: 22 },
  cardTitle: { color: '#f1f5f9', fontSize: 16, fontWeight: '700' },
  cardDescription: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13.5,
    lineHeight: 19,
  },
  cardBtn: {
    height: 42,
    borderRadius: 10,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  cardBtnGranted: {
    backgroundColor: 'rgba(52,243,198,0.15)',
    borderColor: 'rgba(52,243,198,0.4)',
    borderWidth: 1,
  },
  cardBtnLabel: { color: '#0d1b3e', fontSize: 14, fontWeight: '700' },
  cardBtnLabelGranted: { color: ACCENT },
  pressed: { opacity: 0.75 },
  footer: { paddingHorizontal: 24, paddingBottom: 24, paddingTop: 12 },
  continueBtn: {
    height: 50,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueLabel: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
