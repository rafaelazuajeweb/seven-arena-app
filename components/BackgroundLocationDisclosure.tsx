import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

// Google Play exige un aviso propio de la app ("prominent disclosure") ANTES de
// mostrar el diálogo del sistema que pide ACCESS_BACKGROUND_LOCATION. El aviso
// tiene que decir explícitamente que se recopila ubicación cuando la app no está
// en uso, para qué se usa y quién la ve. Ponerlo solo en la política de
// privacidad no cumple: Play evalúa lo que el usuario ve dentro de la app.
//
// El texto de abajo describe el comportamiento real de Seven Arena. Si cambia
// lo que hace el tracking, hay que actualizarlo aquí Y en el Data Safety form
// de Play Console: si no coinciden, la revisión rebota.

type Step = 'disclosure' | 'settings';

type Props = {
  visible: boolean;
  step: Step;
  onAccept: () => void;
  onDecline: () => void;
  onOpenSettings: () => void;
};

const ACCENT = '#34F3C6';
const BG = '#0e1822';

const BULLETS = [
  'La central usa tu ubicación para asignarte traslados y coordinar los viajes en curso.',
  'Se guarda el histórico de tu recorrido durante el turno.',
  'Solo la central de Seven Arena puede verlo. Los pasajeros no acceden a tu ubicación.',
  'El registro se detiene cuando cierras tu turno o cierras sesión en la app.',
];

export default function BackgroundLocationDisclosure({
  visible,
  step,
  onAccept,
  onDecline,
  onOpenSettings,
}: Props) {
  const isSettings = step === 'settings';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // En Android el botón atrás equivale a rechazar: el aviso nunca puede
      // descartarse "sin querer" hacia una concesión de permiso.
      onRequestClose={onDecline}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <ScrollView contentContainerStyle={styles.cardContent}>
            <View style={styles.iconBubble}>
              <Text style={styles.iconText}>📍</Text>
            </View>

            {isSettings ? (
              <>
                <Text style={styles.title}>Falta un paso en Ajustes</Text>
                <Text style={styles.body}>
                  Android no permite conceder este permiso desde la app. Abre los
                  ajustes de Seven Arena, entra en Permisos → Ubicación y elige
                  <Text style={styles.strong}> Permitir todo el tiempo</Text>.
                </Text>
                <Text style={styles.hint}>
                  Si eliges &quot;Permitir solo mientras se usa la app&quot;, tu
                  recorrido dejará de registrarse cuando cierres la app.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.title}>Ubicación mientras estás en turno</Text>
                <Text style={styles.body}>
                  Seven Arena registra tu ubicación mientras tienes el turno
                  activo,
                  <Text style={styles.strong}>
                    {' '}
                    incluso cuando la app está en segundo plano o cerrada
                  </Text>
                  .
                </Text>
                <View style={styles.bullets}>
                  {BULLETS.map((line) => (
                    <View key={line} style={styles.bulletRow}>
                      <Text style={styles.bulletDot}>•</Text>
                      <Text style={styles.bulletText}>{line}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              onPress={isSettings ? onOpenSettings : onAccept}
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
            >
              <Text style={styles.btnLabel}>
                {isSettings ? 'Abrir ajustes' : 'Continuar'}
              </Text>
            </Pressable>
            <Pressable
              onPress={onDecline}
              style={({ pressed }) => [styles.btnGhost, pressed && styles.pressed]}
            >
              <Text style={styles.btnGhostLabel}>Ahora no</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    backgroundColor: BG,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(52,243,198,0.25)',
    overflow: 'hidden',
  },
  cardContent: { paddingHorizontal: 24, paddingTop: 28, alignItems: 'center', gap: 12 },
  iconBubble: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: 'rgba(52,243,198,0.12)',
    borderColor: 'rgba(52,243,198,0.35)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 36 },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f1f5f9',
    textAlign: 'center',
  },
  body: {
    fontSize: 14.5,
    lineHeight: 21,
    color: 'rgba(255,255,255,0.72)',
    textAlign: 'center',
  },
  strong: { color: ACCENT, fontWeight: '700' },
  hint: {
    fontSize: 12.5,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    marginTop: 4,
  },
  bullets: { alignSelf: 'stretch', marginTop: 6, gap: 8 },
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bulletDot: { color: ACCENT, fontSize: 14, lineHeight: 20 },
  bulletText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 20,
    color: 'rgba(255,255,255,0.62)',
  },
  footer: { paddingHorizontal: 24, paddingBottom: 22, paddingTop: 18, gap: 10 },
  btn: {
    height: 52,
    borderRadius: 14,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnLabel: { color: '#0d1b3e', fontSize: 15, fontWeight: '700' },
  btnGhost: { height: 44, alignItems: 'center', justifyContent: 'center' },
  btnGhostLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.75 },
});
