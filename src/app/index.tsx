import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import { JetSurfBleClient } from '@/services/ble-client';
import { bytesToUtf8, parseLogPacket, parseTelemetry, Telemetry } from '@/services/ble-protocol';

const colors = Colors.light;

type ConnectionStatus = 'offline' | 'scanning' | 'connected' | 'error';

type LogFile = {
  name: string;
  totalBytes: number;
  bytes: number[];
  complete: boolean;
  startedAt: number;
};

/** Displays board connection status and the latest telemetry values. */
export default function HomeScreen() {
  const client = useRef(new JetSurfBleClient()).current;
  const [status, setStatus] = useState<ConnectionStatus>('offline');
  const [error, setError] = useState('');
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [downloadStatus, setDownloadStatus] = useState('No log transfer yet');
  const [isDownloading, setIsDownloading] = useState(false);
  const logFiles = useRef(new Map<number, LogFile>()).current;

  useEffect(() => () => client.destroy(), [client]);

  /** Connects to the nearest JetSurf board and subscribes to its data streams. */
  async function connect() {
    setStatus('scanning');
    setError('');

    try {
      await client.connect();
      client.subscribeToTelemetry((bytes) => {
        try {
          setTelemetry(parseTelemetry(bytes));
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : 'Invalid telemetry packet');
        }
      });
      client.subscribeToLogs(handleLogPacket);
      setStatus('connected');
    } catch (connectionError) {
      setStatus('error');
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect');
    }
  }

  /** Ends the board connection and clears the live telemetry display. */
  async function disconnect() {
    await client.disconnect();
    setStatus('offline');
    setTelemetry(null);
  }

  /** Reassembles incoming log packets while the transfer UI is temporarily hidden. */
  function handleLogPacket(bytes: Uint8Array) {
    try {
      const packet = parseLogPacket(bytes);

      if (packet.type === 0x10) {
        const { name, totalBytes } = parseFileStartPayload(packet.payload);
        logFiles.set(packet.fileIndex, {
          name,
          totalBytes,
          bytes: [],
          complete: false,
          startedAt: Date.now(),
        });
        setDownloadStatus(`Receiving ${name}: ${totalBytes > 0 ? '0%' : 'size unknown'}`);
        return;
      }

      if (packet.type === 0x11) {
        const file = logFiles.get(packet.fileIndex);
        if (!file || packet.offset !== file.bytes.length) {
          throw new Error('Log packet offset gap detected');
        }

        file.bytes.push(...packet.payload);
        if (
          file.bytes.length % 1800 < packet.payload.length ||
          (file.totalBytes > 0 && file.bytes.length >= file.totalBytes)
        ) {
          const received = file.bytes.length;
          const remaining = Math.max(0, file.totalBytes - received);
          const elapsedSeconds = (Date.now() - file.startedAt) / 1000;
          const bytesPerSecond = elapsedSeconds > 0 ? received / elapsedSeconds : 0;
          const remainingSeconds = bytesPerSecond > 0 ? remaining / bytesPerSecond : 0;
          const progress = file.totalBytes > 0
            ? `${Math.min(100, Math.round((received / file.totalBytes) * 100))}% - ${formatTimeRemaining(remainingSeconds)} remaining`
            : `${formatBytes(received)} received - size unknown`;

          setDownloadStatus(`Receiving ${file.name}: ${progress}`);
        }
        return;
      }

      if (packet.type === 0x12) {
        const file = logFiles.get(packet.fileIndex);
        if (!file || packet.offset !== file.bytes.length) {
          throw new Error('Log file length mismatch');
        }
        if (file.totalBytes > 0 && file.totalBytes !== packet.offset) {
          throw new Error('Log file size metadata mismatch');
        }

        file.totalBytes = packet.offset;
        file.complete = true;
        setDownloadStatus(`${file.name} complete: ${formatBytes(file.bytes.length)}`);
        return;
      }

      if (packet.type === 0x13) {
        const fileCount = logFiles.size;
        setDownloadStatus(`${fileCount} log file${fileCount === 1 ? '' : 's'} received`);
        setIsDownloading(false);
        return;
      }

      if (packet.type === 0x7f) {
        throw new Error('The board reported a log transfer error');
      }
    } catch (packetError) {
      setIsDownloading(false);
      setError(packetError instanceof Error ? packetError.message : 'Invalid log packet');
    }
  }

  /** Requests the latest board logs for the retained transfer implementation. */
  async function downloadLogs() {
    if (Platform.OS === 'web') {
      setError('Log downloads require an Android or iOS development build.');
      return;
    }
    if (isDownloading) return;

    logFiles.clear();
    setIsDownloading(true);
    setError('');
    setDownloadStatus('Starting transfer...');

    try {
      await client.requestLatestLogs();
    } catch (downloadError) {
      setIsDownloading(false);
      setError(downloadError instanceof Error ? downloadError.message : 'Unable to start log transfer');
    }
  }

  /** Writes a completed log to temporary storage and opens the platform share sheet. */
  async function shareLog(file: LogFile) {
    if (!file.complete) return;

    const uri = `${FileSystem.cacheDirectory}${file.name}`;
    await FileSystem.writeAsStringAsync(uri, encodeBytes(file.bytes), {
      encoding: FileSystem.EncodingType.Base64,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri);
    }
  }

  const connected = status === 'connected';
  const throttlePercent = telemetry ? rawThrottleToPercent(telemetry.bleThrottle) : 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <ThemedText style={styles.eyebrow}>JET SURF 3000</ThemedText>
            <ThemedText style={styles.title}>Ride telemetry</ThemedText>
          </View>
          <View style={[styles.statusDot, connected && styles.statusDotLive]} />
        </View>

        <View style={styles.connectionRow}>
          <View>
            <ThemedText style={styles.statusLabel}>
              {status === 'scanning' ? 'Scanning nearby' : connected ? 'Board connected' : 'Board offline'}
            </ThemedText>
            <ThemedText style={styles.muted}>jetSurfBoard</ThemedText>
          </View>
          <Pressable style={styles.primaryButton} onPress={connected ? disconnect : connect}>
            <ThemedText style={styles.primaryButtonText}>
              {status === 'scanning' ? 'Scanning...' : connected ? 'Disconnect' : 'Connect board'}
            </ThemedText>
          </Pressable>
        </View>

        {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}

        <View style={styles.heroMetric}>
          <ThemedText style={styles.metricLabel}>CURRENT SPEED</ThemedText>
          <View style={styles.speedLine}>
            <ThemedText style={styles.speed}>
              {telemetry ? telemetry.velocityMetSec.toFixed(1) : '--'}
            </ThemedText>
            <ThemedText style={styles.unit}>m/s</ThemedText>
          </View>
          <View style={styles.throttleTrack}>
            <View style={[styles.throttleFill, { width: `${throttlePercent}%` }]} />
          </View>
          <ThemedText style={styles.heroMuted}>
            Throttle {throttlePercent}%
          </ThemedText>
        </View>

        <ThemedText style={styles.sectionTitle}>Power systems</ThemedText>
        <View style={styles.grid}>
          <MetricCard
            label="BATTERY 01"
            value={formatValue(telemetry?.battery1Soc, '%')}
            detail={`${formatValue(telemetry?.battery1Voltage, ' V')} / ${formatValue(telemetry?.battery1Current, ' A')}`}
          />
          <MetricCard
            label="BATTERY 02"
            value={formatValue(telemetry?.battery2Soc, '%')}
            detail={`${formatValue(telemetry?.battery2Voltage, ' V')} / ${formatValue(telemetry?.battery2Current, ' A')}`}
          />
          <MetricCard
            label="HIGHEST TEMP"
            value={formatValue(
              telemetry ? Math.max(telemetry.battery1HighestTemp, telemetry.battery2HighestTemp) : undefined,
              '°C',
            )}
            detail="Across both packs"
          />
          <MetricCard
            label="CELL DELTA"
            value={formatValue(
              telemetry
                ? Math.max(telemetry.battery1CellVoltageDiff, telemetry.battery2CellVoltageDiff)
                : undefined,
              ' mV',
            )}
            detail="Maximum difference"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Renders one battery or system metric in the power systems grid. */
function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={styles.card}>
      <ThemedText style={styles.cardLabel}>{label}</ThemedText>
      <ThemedText style={styles.cardValue}>{value}</ThemedText>
      <ThemedText style={styles.cardDetail}>{detail}</ThemedText>
    </View>
  );
}

/** Formats an optional telemetry number for display. */
function formatValue(value: number | undefined, suffix: string) {
  return value === undefined || !Number.isFinite(value) ? '--' : `${value.toFixed(1)}${suffix}`;
}

/** Converts the raw BLE throttle byte into the percentage shown in the UI. */
function rawThrottleToPercent(rawThrottle: number) {
  const clampedThrottle = Math.min(255, Math.max(0, rawThrottle));
  return Math.round((clampedThrottle / 255) * 100);
}

/** Formats a byte count for transfer status messages. */
function formatBytes(bytes: number) {
  return bytes >= 1000000 ? `${(bytes / 1000000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

/** Formats an estimated transfer duration. */
function formatTimeRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/** Parses either legacy or metadata-prefixed FILE_START payloads. */
function parseFileStartPayload(payload: Uint8Array) {
  const legacyName = bytesToUtf8(payload);
  if (legacyName.startsWith('log') && legacyName.endsWith('.log')) {
    return { name: legacyName, totalBytes: 0 };
  }
  if (payload.length < 5) throw new Error('FILE_START payload is too short');

  const totalBytes = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
  const name = bytesToUtf8(payload.slice(4));
  if (!name.startsWith('log') || !name.endsWith('.log') || totalBytes <= 0) {
    throw new Error('Invalid FILE_START metadata');
  }

  return { name, totalBytes };
}

/** Encodes transferred bytes for the file-system sharing API. */
function encodeBytes(bytes: number[]) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
    result += second === undefined
      ? '=='
      : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
    result += third === undefined ? '=' : alphabet[third & 63];
  }

  return result;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: 22,
    paddingBottom: 84,
    gap: 18,
    maxWidth: 800,
    width: '100%',
    alignSelf: 'center',
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { color: colors.highlight, fontSize: 11, letterSpacing: 1.4, fontWeight: '700' },
  title: {
    color: colors.text,
    fontSize: 32,
    lineHeight: 40,
    fontWeight: '800',
    marginTop: 5,
  },
  statusDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.secondaryText },
  statusDotLive: { backgroundColor: colors.specialHighlight },
  connectionRow: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.secondaryText,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusLabel: { color: colors.text, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.secondaryText, fontSize: 12, marginTop: 4 },
  primaryButton: { backgroundColor: colors.highlight, paddingHorizontal: 15, paddingVertical: 11 },
  primaryButtonText: { color: colors.background, fontWeight: '700', fontSize: 12 },
  error: { color: colors.text, backgroundColor: colors.specialHighlight, padding: 12, fontSize: 13 },
  heroMetric: { backgroundColor: colors.highlight, padding: 22 },
  metricLabel: { color: colors.specialHighlight, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  speedLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5, minHeight: 86 },
  speed: {
    color: colors.background,
    fontSize: 66,
    lineHeight: 82,
    fontWeight: '800',
    includeFontPadding: true,
  },
  unit: { color: colors.background, fontSize: 16 },
  throttleTrack: { backgroundColor: colors.background, height: 6, marginTop: 12 },
  throttleFill: { backgroundColor: colors.specialHighlight, height: 6 },
  heroMuted: { color: colors.background, fontSize: 12, marginTop: 5 },
  sectionTitle: { color: colors.text, fontSize: 19, lineHeight: 28, fontWeight: '800' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.secondaryText,
    padding: 15,
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 145,
  },
  cardLabel: { color: colors.secondaryText, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  cardValue: { color: colors.text, fontSize: 27, fontWeight: '800', marginTop: 8 },
  cardDetail: { color: colors.secondaryText, fontSize: 11, marginTop: 3 },
});
