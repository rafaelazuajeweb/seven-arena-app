import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0e1822' } }}>
        <Stack.Screen name="index" />
      </Stack>
      <StatusBar style="light" backgroundColor="#0e1822" translucent={false} />
    </SafeAreaProvider>
  );
}
