import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { JetSurfBleClient } from '@/services/ble-client';
import { bytesToUtf8, parseLogPacket, parseTelemetry, Telemetry } from '@/services/ble-protocol';

const colors = { ink: '#17231f', muted: '#6b7771', paper: '#f4f6ef', panel: '#fff', green: '#1e6b4f', lime: '#c9e86b', line: '#dce3d9', orange: '#e1763f' };
type ConnectionStatus = 'offline' | 'scanning' | 'connected' | 'error';

type LogFile = { name: string; totalBytes: number; bytes: number[]; complete: boolean; startedAt: number };

export default function HomeScreen() {
  const client = useRef(new JetSurfBleClient()).current;
  const [status, setStatus] = useState<ConnectionStatus>('offline');
  const [error, setError] = useState('');
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [downloadStatus, setDownloadStatus] = useState('No log transfer yet');
  const [isDownloading, setIsDownloading] = useState(false);
  const [fileVersion, setFileVersion] = useState(0);
  const logFiles = useRef(new Map<number, LogFile>()).current;

  useEffect(() => () => client.destroy(), [client]);

  async function connect() {
    setStatus('scanning'); setError('');
    try {
      await client.connect();
      client.subscribeToTelemetry((bytes) => { try { setTelemetry(parseTelemetry(bytes)); } catch (parseError) { setError(parseError instanceof Error ? parseError.message : 'Invalid telemetry packet'); } });
      client.subscribeToLogs(handleLogPacket);
      setStatus('connected');
    } catch (connectionError) { setStatus('error'); setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect'); }
  }

  async function disconnect() { await client.disconnect(); setStatus('offline'); setTelemetry(null); }

  function handleLogPacket(bytes: Uint8Array) {
    try {
      const packet = parseLogPacket(bytes);
      if (packet.type === 0x10) {
        const { name, totalBytes } = parseFileStartPayload(packet.payload);
        logFiles.set(packet.fileIndex, { name, totalBytes, bytes: [], complete: false, startedAt: Date.now() });
        setDownloadStatus(`Receiving ${name}: ${totalBytes > 0 ? '0%' : 'size unknown'}`);
      }
      else if (packet.type === 0x11) {
        const file = logFiles.get(packet.fileIndex);
        if (!file || packet.offset !== file.bytes.length) throw new Error('Log packet offset gap detected');
        file.bytes.push(...packet.payload);
        if (file.bytes.length % 1800 < packet.payload.length || (file.totalBytes > 0 && file.bytes.length >= file.totalBytes)) {
          const received = file.bytes.length;
          const remaining = Math.max(0, file.totalBytes - received);
          const elapsedSeconds = (Date.now() - file.startedAt) / 1000;
          const bytesPerSecond = elapsedSeconds > 0 ? received / elapsedSeconds : 0;
          const remainingSeconds = bytesPerSecond > 0 ? remaining / bytesPerSecond : 0;
          const progress = file.totalBytes > 0 ? `${Math.min(100, Math.round((received / file.totalBytes) * 100))}% — ${formatTimeRemaining(remainingSeconds)} remaining` : `${formatBytes(received)} received — size unknown`;
          setDownloadStatus(`Receiving ${file.name}: ${progress}`);
        }
      }
      else if (packet.type === 0x12) {
        const file = logFiles.get(packet.fileIndex);
        if (!file || packet.offset !== file.bytes.length) throw new Error('Log file length mismatch');
        if (file.totalBytes > 0 && file.totalBytes !== packet.offset) throw new Error('Log file size metadata mismatch');
        file.totalBytes = packet.offset;
        file.complete = true;
        setDownloadStatus(`${file.name} complete: ${formatBytes(file.bytes.length)}`);
        setFileVersion((value) => value + 1);
      }
      else if (packet.type === 0x13) { setDownloadStatus(`${logFiles.size} log file${logFiles.size === 1 ? '' : 's'} received`); setIsDownloading(false); setFileVersion((value) => value + 1); }
      else if (packet.type === 0x7f) throw new Error('The board reported a log transfer error');
    } catch (packetError) { setIsDownloading(false); setError(packetError instanceof Error ? packetError.message : 'Invalid log packet'); }
  }

  async function downloadLogs() {
    if (Platform.OS === 'web') { setError('Log downloads require an Android or iOS development build.'); return; }
    if (isDownloading) return;
    logFiles.clear(); setFileVersion((value) => value + 1); setIsDownloading(true); setError(''); setDownloadStatus('Starting transfer...');
    try { await client.requestLatestLogs(); } catch (downloadError) { setIsDownloading(false); setError(downloadError instanceof Error ? downloadError.message : 'Unable to start log transfer'); }
  }

  async function shareLog(file: LogFile) {
    if (!file.complete) return;
    const uri = `${FileSystem.cacheDirectory}${file.name}`;
    await FileSystem.writeAsStringAsync(uri, encodeBytes(file.bytes), { encoding: FileSystem.EncodingType.Base64 });
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
  }

  const connected = status === 'connected';
  return <SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><View><ThemedText style={styles.eyebrow}>JET SURF / BOARD LINK</ThemedText><ThemedText style={styles.title}>Ride telemetry</ThemedText></View><View style={[styles.statusDot, connected && styles.statusDotLive]} /></View>
    <View style={styles.connectionRow}><View><ThemedText style={styles.statusLabel}>{status === 'scanning' ? 'Scanning nearby' : connected ? 'Board connected' : 'Board offline'}</ThemedText><ThemedText style={styles.muted}>jetSurfBoard</ThemedText></View><Pressable style={styles.primaryButton} onPress={connected ? disconnect : connect}><ThemedText style={styles.primaryButtonText}>{status === 'scanning' ? 'Scanning...' : connected ? 'Disconnect' : 'Connect board'}</ThemedText></Pressable></View>
    {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}
    <View style={styles.heroMetric}><ThemedText style={styles.metricLabel}>CURRENT SPEED</ThemedText><View style={styles.speedLine}><ThemedText style={styles.speed}>{telemetry ? telemetry.velocityMetSec.toFixed(1) : '--'}</ThemedText><ThemedText style={styles.unit}>m/s</ThemedText></View><View style={styles.throttleTrack}><View style={[styles.throttleFill, { width: `${telemetry?.bleThrottle ?? 0}%` }]} /></View><ThemedText style={styles.heroMuted}>Throttle {telemetry ? telemetry.bleThrottle : 0}%</ThemedText></View>
    <ThemedText style={styles.sectionTitle}>Power systems</ThemedText><View style={styles.grid}>
      <MetricCard label="BATTERY 01" value={formatValue(telemetry?.battery1Soc, '%')} detail={`${formatValue(telemetry?.battery1Voltage, ' V')} / ${formatValue(telemetry?.battery1Current, ' A')}`} />
      <MetricCard label="BATTERY 02" value={formatValue(telemetry?.battery2Soc, '%')} detail={`${formatValue(telemetry?.battery2Voltage, ' V')} / ${formatValue(telemetry?.battery2Current, ' A')}`} />
      <MetricCard label="HIGHEST TEMP" value={formatValue(telemetry ? Math.max(telemetry.battery1HighestTemp, telemetry.battery2HighestTemp) : undefined, '°C')} detail="Across both packs" />
      <MetricCard label="CELL DELTA" value={formatValue(telemetry ? Math.max(telemetry.battery1CellVoltageDiff, telemetry.battery2CellVoltageDiff) : undefined, ' V')} detail="Maximum difference" />
    </View>
    <View style={styles.logSection}><View style={styles.sectionHeader}><ThemedText style={styles.sectionTitle}>Ride logs</ThemedText><ThemedText style={styles.muted}>{downloadStatus}</ThemedText></View><ThemedText style={styles.logCopy}>Download the current session from the board for analysis after your ride.</ThemedText><Pressable style={[styles.downloadButton, (!connected || isDownloading) && styles.disabled]} onPress={downloadLogs} disabled={!connected || isDownloading}><ThemedText style={styles.downloadButtonText}>{isDownloading ? 'Receiving logs...' : 'Download latest session'}</ThemedText></Pressable>{Array.from(logFiles.values()).map((file) => <Pressable key={`${file.name}-${fileVersion}`} style={[styles.fileRow, !file.complete && styles.fileRowPending]} onPress={() => shareLog(file)} disabled={!file.complete}><ThemedText style={styles.fileName}>{file.name} {!file.complete && `(${formatBytes(file.bytes.length)} received)`}</ThemedText><ThemedText style={styles.shareText}>{file.complete ? 'Share' : 'Receiving...'}</ThemedText></Pressable>)}</View>
  </ScrollView></SafeAreaView>;
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) { return <View style={styles.card}><ThemedText style={styles.cardLabel}>{label}</ThemedText><ThemedText style={styles.cardValue}>{value}</ThemedText><ThemedText style={styles.cardDetail}>{detail}</ThemedText></View>; }
function formatValue(value: number | undefined, suffix: string) { return value === undefined || !Number.isFinite(value) ? '--' : `${value.toFixed(1)}${suffix}`; }
function formatBytes(bytes: number) { return bytes >= 1000000 ? `${(bytes / 1000000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`; }
function formatTimeRemaining(seconds: number) { if (!Number.isFinite(seconds) || seconds <= 0) return '--'; if (seconds < 60) return `${Math.ceil(seconds)}s`; const minutes = Math.floor(seconds / 60); const secs = Math.ceil(seconds % 60); return `${minutes}m ${secs}s`; }
function parseFileStartPayload(payload: Uint8Array) {
  const legacyName = bytesToUtf8(payload);
  if (legacyName.startsWith('log') && legacyName.endsWith('.log')) return { name: legacyName, totalBytes: 0 };
  if (payload.length < 5) throw new Error('FILE_START payload is too short');
  const totalBytes = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
  const name = bytesToUtf8(payload.slice(4));
  if (!name.startsWith('log') || !name.endsWith('.log') || totalBytes <= 0) throw new Error('Invalid FILE_START metadata');
  return { name, totalBytes };
}
function encodeBytes(bytes: number[]) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let result = ''; for (let index = 0; index < bytes.length; index += 3) { const first = bytes[index]; const second = bytes[index + 1]; const third = bytes[index + 2]; result += alphabet[first >> 2] + alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)]; result += second === undefined ? '==' : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)]; result += third === undefined ? '=' : alphabet[third & 63]; } return result; }

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper }, content: { padding: 22, gap: 18, maxWidth: 800, width: '100%', alignSelf: 'center' }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, eyebrow: { color: colors.green, fontSize: 11, letterSpacing: 1.4, fontWeight: '700' }, title: { color: colors.ink, fontSize: 32, fontWeight: '800', marginTop: 5 }, statusDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.line }, statusDotLive: { backgroundColor: colors.lime }, connectionRow: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, statusLabel: { color: colors.ink, fontSize: 16, fontWeight: '700' }, muted: { color: colors.muted, fontSize: 12, marginTop: 4 }, primaryButton: { backgroundColor: colors.green, paddingHorizontal: 15, paddingVertical: 11 }, primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 12 }, error: { color: '#a33f28', backgroundColor: '#fbe8df', padding: 12, fontSize: 13 }, heroMetric: { backgroundColor: colors.green, padding: 22 }, metricLabel: { color: colors.lime, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 }, speedLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 5 }, speed: { color: '#fff', fontSize: 66, fontWeight: '800' }, unit: { color: '#c8d9cf', fontSize: 16 }, throttleTrack: { backgroundColor: '#4c886f', height: 6, marginTop: 12 }, throttleFill: { backgroundColor: colors.lime, height: 6 }, heroMuted: { color: '#c8d9cf', fontSize: 12, marginTop: 5 }, sectionTitle: { color: colors.ink, fontSize: 19, fontWeight: '800' }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, padding: 15, flexGrow: 1, flexBasis: '45%', minWidth: 145 }, cardLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, cardValue: { color: colors.ink, fontSize: 26, fontWeight: '800', marginTop: 10 }, cardDetail: { color: colors.muted, fontSize: 12, marginTop: 5 }, logSection: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 18 }, sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }, logCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 7 }, downloadButton: { backgroundColor: colors.orange, padding: 14, alignItems: 'center', marginTop: 14 }, disabled: { opacity: 0.45 }, downloadButtonText: { color: '#fff', fontWeight: '800' }, fileRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.line }, fileRowPending: { opacity: 0.55 }, fileName: { color: colors.ink, fontWeight: '700' }, shareText: { color: colors.green, fontWeight: '800' },
});
