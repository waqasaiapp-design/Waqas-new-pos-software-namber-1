import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import https from 'https';
import { execFile, spawn, ChildProcess } from 'child_process';
import type {
  CctvCamera,
  CctvCameraInput,
  CctvCameraType,
  CctvCapabilities,
  CctvConnectionTestResult,
  CctvErrorCode,
  CctvGatewayStatus,
  CctvPlaybackProtocol,
  CctvRecordingEntry,
  CctvRecordingMode,
  CctvRecordingSchedule,
  CctvStorageSummary,
  CctvSystemSettings,
  DvrNvrConfig,
} from './src/types/pos.ts';

export interface CctvCameraStored extends Omit<CctvCamera, 'streamUrl'> {
  passwordEncrypted?: string;
  streamUrlEncrypted?: string;
}

export interface DvrNvrStoredConfig extends DvrNvrConfig {
  passwordEncrypted?: string;
}

export interface CctvSystemStoredSettings extends CctvSystemSettings {
  pinHash?: string;
  pinSalt?: string;
}

export type CctvPtzAction =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'zoom_in'
  | 'zoom_out'
  | 'stop';

interface ActiveHlsWorker {
  key: string;
  shopId: string;
  cameraId: string;
  dir: string;
  proc: ChildProcess;
  startedAt: number;
  lastViewerAt: number;
  sourceUrl: string;
  ready: boolean;
  failedReason?: string;
}

interface ActiveRecordingWorker {
  id: string;
  shopId: string;
  cameraId: string;
  cameraName: string;
  filePath: string;
  metaPath: string;
  fileName: string;
  proc: ChildProcess;
  startedAt: string;
  trigger: 'manual' | 'scheduled' | 'continuous' | 'motion';
  status: 'recording' | 'ready' | 'failed';
}

const VALID_CAMERA_TYPES: CctvCameraType[] = [
  'ip',
  'rtsp',
  'onvif',
  'dvr',
  'nvr',
  'hls',
  'webrtc',
  'mjpeg',
];

const ALLOWED_STREAM_PROTOCOLS = new Set(['rtsp:', 'rtsps:', 'http:', 'https:', 'ws:', 'wss:']);

let cachedBinaryCheck: { checkedAt: number; ffmpeg: boolean; ffprobe: boolean } | null = null;
const cachedKeyByDir = new Map<string, Buffer>();

export function detectMediaBinaries(): { ffmpegAvailable: boolean; ffprobeAvailable: boolean } {
  const now = Date.now();
  if (cachedBinaryCheck && now - cachedBinaryCheck.checkedAt < 60_000) {
    return {
      ffmpegAvailable: cachedBinaryCheck.ffmpeg,
      ffprobeAvailable: cachedBinaryCheck.ffprobe,
    };
  }
  const checkBin = (cmd: string): boolean => {
    try {
      const pathDirs = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
      for (const dir of pathDirs) {
        if (!dir) continue;
        const candidate = path.join(dir, cmd);
        if (fs.existsSync(candidate)) return true;
      }
      return false;
    } catch {
      return false;
    }
  };
  const ffmpeg = checkBin('ffmpeg');
  const ffprobe = checkBin('ffprobe');
  cachedBinaryCheck = { checkedAt: now, ffmpeg, ffprobe };
  return { ffmpegAvailable: ffmpeg, ffprobeAvailable: ffprobe };
}

function getOrCreateEncryptionKey(dataDir: string): Buffer {
  const envSecret = (
    process.env.WAQAS_CCTV_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.WAQAS_SESSION_SECRET ||
    ''
  ).trim();
  if (envSecret) {
    return crypto.createHash('sha256').update(`waqas-cctv-v1:${envSecret}`).digest();
  }
  const cached = cachedKeyByDir.get(dataDir);
  if (cached) return cached;

  const keyFile = path.resolve(dataDir, '.cctv_master_key');
  try {
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[a-fA-F0-9]{64}$/.test(hex)) {
        const key = Buffer.from(hex, 'hex');
        cachedKeyByDir.set(dataDir, key);
        return key;
      }
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const freshHex = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, freshHex, { mode: 0o600 });
    const key = Buffer.from(freshHex, 'hex');
    cachedKeyByDir.set(dataDir, key);
    return key;
  } catch {
    const fallback = crypto.randomBytes(32);
    cachedKeyByDir.set(dataDir, fallback);
    return fallback;
  }
}

export function encryptCctvSecret(plain: string, dataDir: string): string {
  const clean = String(plain || '');
  if (!clean) return '';
  const key = getOrCreateEncryptionKey(dataDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptCctvSecret(payload: string | undefined, dataDir: string): string {
  if (!payload || typeof payload !== 'string') return '';
  if (!payload.startsWith('v1:')) return payload;
  const parts = payload.split(':');
  if (parts.length !== 4) return '';
  try {
    const [, ivHex, tagHex, dataHex] = parts;
    const key = getOrCreateEncryptionKey(dataDir);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

export function maskCredentialsInUrl(rawUrl: string | undefined): string {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.password) {
      parsed.password = '••••••';
    }
    const sensitiveParams = ['password', 'pass', 'pwd', 'token', 'auth', 'secret', 'key'];
    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '••••••');
      }
    }
    return parsed.toString();
  } catch {
    return raw.replace(/:([^:@/\s]+)@/g, ':••••••@');
  }
}

export function sanitizeIdSegment(val: string): string {
  return String(val || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
}

export function resolveConfinedPath(baseDir: string, ...segments: string[]): string | null {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, ...segments);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return target;
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function isValidHostnameOrIp(host: string): boolean {
  const clean = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!clean || clean.length > 253) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    return isValidIpv4(clean);
  }
  if (net.isIP(clean) !== 0) return true;
  return /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
    clean
  );
}

export function isPrivateLanIp(host: string): boolean {
  const clean = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!isValidIpv4(clean)) return false;
  const [a, b] = clean.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function isBlockedSsrfHost(host: string): { blocked: boolean; reason?: string } {
  const clean = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return { blocked: true, reason: 'Empty host' };
  if (
    clean === 'metadata.google.internal' ||
    clean === 'metadata' ||
    clean === '0.0.0.0' ||
    clean === '::' ||
    clean === 'fd00:ec2::254'
  ) {
    return { blocked: true, reason: 'Metadata/unspecified host is not permitted.' };
  }
  if (isValidIpv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    if (a === 169 && b === 254) {
      return { blocked: true, reason: 'Cloud metadata IP range (169.254.0.0/16) is blocked.' };
    }
    if (a === 127 && process.env.WAQAS_ALLOW_LOOPBACK_CAMERAS !== '1') {
      return {
        blocked: true,
        reason: 'Loopback address (127.0.0.x) is disabled for security. Use the camera/DVR LAN IP or public DDNS host.',
      };
    }
  }
  if ((clean === 'localhost' || clean === '::1') && process.env.WAQAS_ALLOW_LOOPBACK_CAMERAS !== '1') {
    return {
      blocked: true,
      reason: 'Localhost camera targets are disabled for security. Use your camera/DVR LAN IP address.',
    };
  }
  return { blocked: false };
}

export function defaultPortForType(cameraType: CctvCameraType): number {
  switch (cameraType) {
    case 'hls':
    case 'mjpeg':
    case 'ip':
      return 80;
    case 'onvif':
      return 80;
    case 'webrtc':
      return 8889;
    case 'rtsp':
    case 'dvr':
    case 'nvr':
    default:
      return 554;
  }
}

export function defaultCapabilitiesForCamera(
  cam: Partial<CctvCameraStored>,
  ffmpegAvailable: boolean
): CctvCapabilities {
  const t = cam.cameraType || 'rtsp';
  const playbackProtocol: CctvPlaybackProtocol =
    t === 'hls'
      ? 'hls'
      : t === 'mjpeg'
      ? 'mjpeg'
      : t === 'webrtc'
      ? 'webrtc'
      : ffmpegAvailable
      ? 'hls'
      : 'none';
  return {
    liveVideo: playbackProtocol !== 'none',
    audio: Boolean(cam.supportsAudio),
    snapshot: t === 'mjpeg' || t === 'ip' || ffmpegAvailable,
    ptz: Boolean(cam.supportsPtz),
    recording: ffmpegAvailable && t !== 'webrtc',
    playback: ffmpegAvailable,
    playbackProtocol,
  };
}

export function sanitizeCameraForClient(
  cam: CctvCameraStored,
  dataDir: string,
  activeRecordingIds?: Set<string>
): CctvCamera {
  const { ffmpegAvailable } = detectMediaBinaries();
  const rawUrl = cam.streamUrlEncrypted
    ? decryptCctvSecret(cam.streamUrlEncrypted, dataDir)
    : (cam as any).streamUrl || '';
  const hasPassword = Boolean(cam.passwordEncrypted || (rawUrl && /:\/\/[^:]+:[^@]+@/.test(rawUrl)));
  const safeType: CctvCameraType = VALID_CAMERA_TYPES.includes(cam.cameraType)
    ? cam.cameraType
    : 'rtsp';
  return {
    id: cam.id,
    name: cam.name,
    model: cam.model || undefined,
    group: cam.group || cam.location || 'Main Shop',
    channelNumber: Number(cam.channelNumber) || 1,
    cameraType: safeType,
    ipAddress: cam.ipAddress || '',
    port: Number(cam.port) || defaultPortForType(safeType),
    username: cam.username || '',
    hasPassword,
    streamUrlMasked: rawUrl ? maskCredentialsInUrl(rawUrl) : undefined,
    onvifPath: cam.onvifPath,
    status: cam.status || 'offline',
    errorCode: cam.errorCode,
    lastError: cam.lastError ? maskCredentialsInUrl(cam.lastError) : undefined,
    latencyMs: cam.latencyMs,
    location: cam.location || 'Main Shop',
    description: cam.description,
    resolution: cam.resolution || '1080p FHD',
    codec: cam.codec,
    supportsPtz: Boolean(cam.supportsPtz),
    supportsAudio: Boolean(cam.supportsAudio),
    supportsRecording: ffmpegAvailable && safeType !== 'webrtc',
    capabilities: cam.capabilities || defaultCapabilitiesForCamera(cam, ffmpegAvailable),
    isRecording: activeRecordingIds ? activeRecordingIds.has(cam.id) : Boolean(cam.isRecording),
    recordingMode: cam.recordingMode || 'manual',
    schedule: cam.schedule,
    motionDetectionEnabled: Boolean(cam.motionDetectionEnabled),
    motionSensitivity: typeof cam.motionSensitivity === 'number' ? cam.motionSensitivity : 60,
    lastPing: cam.lastPing,
    lastCheckedAt: cam.lastCheckedAt,
    lastConnectedAt: cam.lastConnectedAt,
    updatedAt: cam.updatedAt,
  };
}

export function sanitizeDvrConfigForClient(cfg?: DvrNvrStoredConfig | null): DvrNvrConfig {
  const base: DvrNvrStoredConfig = cfg && typeof cfg === 'object'
    ? cfg
    : {
        brand: 'Hikvision',
        dvrIp: '192.168.1.100',
        port: 554,
        username: 'admin',
        channelCount: 8,
        connected: false,
      };
  return {
    brand: base.brand || 'Hikvision',
    dvrIp: base.dvrIp || '192.168.1.100',
    port: Number(base.port) || 554,
    username: base.username || 'admin',
    hasPassword: Boolean(base.passwordEncrypted),
    channelCount: Number(base.channelCount) || 8,
    connected: Boolean(base.connected),
    lastCheckedAt: base.lastCheckedAt,
    lastError: base.lastError,
  };
}

export function defaultCctvSystemSettings(): CctvSystemStoredSettings {
  return {
    defaultGridLayout: '2x2',
    defaultRecordingMode: 'manual',
    schedule: {
      enabled: false,
      days: [0, 1, 2, 3, 4, 5, 6],
      startTime: '08:00',
      endTime: '23:00',
    },
    motionDetection: {
      enabled: false,
      sensitivity: 60,
      recordOnMotion: false,
      notifyInApp: true,
      alertSound: false,
    },
    storage: {
      retentionDays: 30,
      maxStorageMb: 2048,
      autoDeleteExpired: false,
      warningThresholdPercent: 80,
    },
    security: {
      pinEnabled: false,
      staffViewOnly: false,
    },
  };
}

export function normalizeCctvSystemSettings(
  raw?: Partial<CctvSystemStoredSettings> | null,
  existing?: CctvSystemStoredSettings | null
): CctvSystemStoredSettings {
  const def = defaultCctvSystemSettings();
  const prev = existing || def;
  const r = raw && typeof raw === 'object' ? raw : ({} as Partial<CctvSystemStoredSettings>);
  const validGrid = ['1x1', '2x2', '3x3', '4x4'].includes(String(r.defaultGridLayout || prev.defaultGridLayout))
    ? (r.defaultGridLayout || prev.defaultGridLayout)
    : '2x2';
  const validMode: CctvRecordingMode = ['manual', 'continuous', 'motion', 'scheduled'].includes(
    String(r.defaultRecordingMode || prev.defaultRecordingMode)
  )
    ? ((r.defaultRecordingMode || prev.defaultRecordingMode) as CctvRecordingMode)
    : 'manual';

  const sched = r.schedule || prev.schedule || def.schedule;
  const motion = r.motionDetection || prev.motionDetection || def.motionDetection;
  const stor = r.storage || prev.storage || def.storage;
  const sec = r.security || prev.security || def.security;

  const pinHash = typeof (r as any).pinHash === 'string' ? (r as any).pinHash : prev.pinHash;
  const pinSalt = typeof (r as any).pinSalt === 'string' ? (r as any).pinSalt : prev.pinSalt;

  return {
    defaultGridLayout: validGrid as CctvSystemSettings['defaultGridLayout'],
    defaultRecordingMode: validMode,
    schedule: {
      enabled: Boolean(sched.enabled),
      days: Array.isArray(sched.days)
        ? sched.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [0, 1, 2, 3, 4, 5, 6],
      startTime: /^\d{2}:\d{2}$/.test(String(sched.startTime || '')) ? String(sched.startTime) : '08:00',
      endTime: /^\d{2}:\d{2}$/.test(String(sched.endTime || '')) ? String(sched.endTime) : '23:00',
    },
    motionDetection: {
      enabled: Boolean(motion.enabled),
      sensitivity: Math.max(1, Math.min(100, Number(motion.sensitivity) || 60)),
      recordOnMotion: Boolean(motion.recordOnMotion),
      notifyInApp: motion.notifyInApp !== false,
      alertSound: Boolean(motion.alertSound),
    },
    storage: {
      retentionDays: Math.max(1, Math.min(365, Number(stor.retentionDays) || 30)),
      maxStorageMb: Math.max(100, Math.min(500000, Number(stor.maxStorageMb) || 2048)),
      autoDeleteExpired: Boolean(stor.autoDeleteExpired),
      warningThresholdPercent: Math.max(50, Math.min(98, Number(stor.warningThresholdPercent) || 80)),
    },
    security: {
      pinEnabled: Boolean(pinHash),
      staffViewOnly: Boolean(sec.staffViewOnly),
    },
    ...(pinHash && pinSalt ? { pinHash, pinSalt } : {}),
  };
}

export function sanitizeCctvSettingsForClient(cfg?: CctvSystemStoredSettings | null): CctvSystemSettings {
  const normalized = normalizeCctvSystemSettings(cfg, cfg);
  return {
    defaultGridLayout: normalized.defaultGridLayout,
    defaultRecordingMode: normalized.defaultRecordingMode,
    schedule: normalized.schedule,
    motionDetection: normalized.motionDetection,
    storage: normalized.storage,
    security: {
      pinEnabled: Boolean(normalized.pinHash && normalized.pinSalt),
      staffViewOnly: Boolean(normalized.security.staffViewOnly),
    },
  };
}

export function hashCctvPin(pin: string): { pinHash: string; pinSalt: string } {
  const pinSalt = crypto.randomBytes(16).toString('hex');
  const pinHash = crypto.scryptSync(String(pin), pinSalt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { pinHash, pinSalt };
}

export function verifyCctvPin(pin: string, cfg?: CctvSystemStoredSettings | null): boolean {
  if (!cfg?.pinHash || !cfg?.pinSalt) return false;
  try {
    const derived = crypto.scryptSync(String(pin), cfg.pinSalt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    const a = Buffer.from(derived, 'hex');
    const b = Buffer.from(cfg.pinHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isScheduleActiveNow(schedule?: CctvRecordingSchedule | null, now = new Date()): boolean {
  if (!schedule || !schedule.enabled) return false;
  const day = now.getDay();
  if (!Array.isArray(schedule.days) || !schedule.days.includes(day)) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (schedule.startTime <= schedule.endTime) {
    return hhmm >= schedule.startTime && hhmm <= schedule.endTime;
  }
  return hhmm >= schedule.startTime || hhmm <= schedule.endTime;
}

export interface ResolvedCameraTarget {
  ok: boolean;
  errorCode?: CctvErrorCode;
  message?: string;
  effectiveUrl?: string;
  host?: string;
  port?: number;
  protocol?: string;
  username?: string;
  password?: string;
  cameraType: CctvCameraType;
}

export function resolveEffectiveCameraTarget(params: {
  cameraType?: CctvCameraType;
  ipAddress?: string;
  port?: number;
  username?: string;
  password?: string;
  streamUrl?: string;
  channelNumber?: number;
  dvrConfig?: DvrNvrStoredConfig;
  dvrPassword?: string;
}): ResolvedCameraTarget {
  const cameraType: CctvCameraType = VALID_CAMERA_TYPES.includes(params.cameraType as CctvCameraType)
    ? (params.cameraType as CctvCameraType)
    : 'rtsp';
  const rawStreamUrl = String(params.streamUrl || '').trim();
  const rawIp = String(params.ipAddress || '').trim();
  const rawPort = params.port !== undefined && params.port !== null && String(params.port) !== ''
    ? Number(params.port)
    : undefined;
  const username = String(params.username ?? params.dvrConfig?.username ?? '').trim();
  const password = String(params.password ?? params.dvrPassword ?? '');
  const channel = Math.max(1, Number(params.channelNumber) || 1);

  if (rawPort !== undefined && (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535)) {
    return {
      ok: false,
      cameraType,
      errorCode: 'INVALID_IP_OR_URL',
      message: 'Invalid port number. Port must be between 1 and 65535.',
    };
  }

  if (rawStreamUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawStreamUrl);
    } catch {
      return {
        ok: false,
        cameraType,
        errorCode: 'INVALID_IP_OR_URL',
        message: 'Invalid stream URL format. Use rtsp://, http://, or https://.',
      };
    }

    if (!ALLOWED_STREAM_PROTOCOLS.has(parsed.protocol)) {
      return {
        ok: false,
        cameraType,
        errorCode: 'UNSUPPORTED_FORMAT',
        message: `Unsupported stream protocol "${parsed.protocol}". Supported protocols: RTSP, HTTP, HTTPS, HLS, MJPEG, WebRTC.`,
      };
    }

    const host = parsed.hostname;
    if (!isValidHostnameOrIp(host)) {
      return {
        ok: false,
        cameraType,
        errorCode: 'INVALID_IP_OR_URL',
        message: 'Invalid IP address or hostname in stream URL.',
      };
    }
    const ssrf = isBlockedSsrfHost(host);
    if (ssrf.blocked) {
      return {
        ok: false,
        cameraType,
        errorCode: 'INVALID_IP_OR_URL',
        message: ssrf.reason,
      };
    }

    const port =
      rawPort ||
      (parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? 80 : 554);

    const safeDecode = (v: string) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    const decodedUser = parsed.username ? safeDecode(parsed.username) : '';
    const decodedPass = parsed.password ? safeDecode(parsed.password) : '';

    if (username && !parsed.username) parsed.username = username;
    if (password && !parsed.password) parsed.password = password;

    return {
      ok: true,
      cameraType,
      effectiveUrl: parsed.toString(),
      host,
      port,
      protocol: parsed.protocol,
      username: username || decodedUser,
      password: password || decodedPass,
    };
  }

  const host = rawIp || (cameraType === 'dvr' || cameraType === 'nvr' ? String(params.dvrConfig?.dvrIp || '').trim() : '');
  if (!host) {
    return {
      ok: false,
      cameraType,
      errorCode: 'INVALID_IP_OR_URL',
      message: 'Please provide either a valid Camera IP Address / Host or a Stream URL.',
    };
  }
  if (!isValidHostnameOrIp(host)) {
    return {
      ok: false,
      cameraType,
      errorCode: 'INVALID_IP_OR_URL',
      message: `Invalid IP address or hostname "${host}". Enter a valid IPv4 (e.g. 192.168.1.100) or DDNS hostname.`,
    };
  }
  const ssrf = isBlockedSsrfHost(host);
  if (ssrf.blocked) {
    return {
      ok: false,
      cameraType,
      errorCode: 'INVALID_IP_OR_URL',
      message: ssrf.reason,
    };
  }

  const port = rawPort || (cameraType === 'dvr' || cameraType === 'nvr' ? Number(params.dvrConfig?.port) || 554 : defaultPortForType(cameraType));
  const scheme =
    cameraType === 'hls' || cameraType === 'mjpeg' || cameraType === 'ip' || cameraType === 'webrtc'
      ? port === 443
        ? 'https:'
        : 'http:'
      : 'rtsp:';

  let defaultPath = `/ch${channel}/main`;
  if (cameraType === 'dvr' || cameraType === 'nvr') {
    const brand = params.dvrConfig?.brand || 'Hikvision';
    if (brand === 'Hikvision') defaultPath = `/Streaming/Channels/${channel}01`;
    else if (brand === 'Dahua') defaultPath = `/cam/realmonitor?channel=${channel}&subtype=0`;
    else if (brand === 'Uniview') defaultPath = `/media/video${channel}`;
    else defaultPath = `/ch${channel}/main`;
  } else if (cameraType === 'mjpeg') {
    defaultPath = `/video`;
  } else if (cameraType === 'hls') {
    defaultPath = `/stream.m3u8`;
  } else if (cameraType === 'onvif') {
    defaultPath = `/onvif1`;
  } else if (cameraType === 'webrtc') {
    defaultPath = `/cam${channel}/whep`;
  } else if (cameraType === 'ip') {
    defaultPath = `/video.mp4`;
  }

  const built = new URL(`${scheme}//${host.includes(':') ? `[${host}]` : host}:${port}${defaultPath}`);
  if (username) built.username = username;
  if (password) built.password = password;

  return {
    ok: true,
    cameraType,
    effectiveUrl: built.toString(),
    host,
    port,
    protocol: scheme,
    username,
    password,
  };
}

function checkTcpPort(host: string, port: number, timeoutMs = 3500): Promise<{ ok: boolean; latencyMs: number; code?: string; errMsg?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const socket = net.createConnection({ host, port });

    const done = (result: { ok: boolean; code?: string; errMsg?: string }) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve({ ...result, latencyMs: Date.now() - start });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done({ ok: true }));
    socket.on('timeout', () => done({ ok: false, code: 'ETIMEDOUT', errMsg: 'Connection timed out' }));
    socket.on('error', (err: any) => done({ ok: false, code: err?.code || 'ERR', errMsg: err?.message }));
  });
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 6500
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: any }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', error });
      } else {
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

function probeHttpStream(
  targetUrl: string,
  username?: string,
  password?: string,
  timeoutMs = 4500
): Promise<{
  ok: boolean;
  statusCode: number;
  contentType: string;
  bodySnippet: string;
  errorCode?: string;
  errMsg?: string;
}> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return resolve({ ok: false, statusCode: 0, contentType: '', bodySnippet: '', errorCode: 'INVALID_URL' });
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { Accept: '*/*', 'User-Agent': 'WAQAS-POS-CCTV-Gateway/1.0' };
    if (username || password) {
      headers['Authorization'] = `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;
    }

    // Strip embedded user:pass from URL passed to http.request options because we already set Authorization header
    const cleanUrl = new URL(parsed.toString());
    cleanUrl.username = '';
    cleanUrl.password = '';

    let settled = false;
    const req = client.request(
      cleanUrl,
      { method: 'GET', headers, timeout: timeoutMs },
      (res) => {
        const statusCode = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        const chunks: Buffer[] = [];
        let bytesRead = 0;

        res.on('data', (chunk: Buffer) => {
          if (bytesRead < 4096) {
            chunks.push(chunk);
            bytesRead += chunk.length;
          }
          if (bytesRead >= 2048 || contentType.includes('multipart/x-mixed-replace') || contentType.includes('video/')) {
            res.destroy();
          }
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            ok: statusCode >= 200 && statusCode < 400,
            statusCode,
            contentType,
            bodySnippet: Buffer.concat(chunks).toString('utf8', 0, Math.min(bytesRead, 1024)),
          });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      }
    );

    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ ok: false, statusCode: 0, contentType: '', bodySnippet: '', errorCode: 'ETIMEDOUT', errMsg: 'HTTP request timed out' });
    });

    req.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, statusCode: 0, contentType: '', bodySnippet: '', errorCode: err?.code || 'ERR', errMsg: err?.message });
    });

    req.end();
  });
}

function classifyTcpFailure(
  code: string | undefined,
  host: string,
  port: number
): { errorCode: CctvErrorCode; message: string } {
  const isLan = isPrivateLanIp(host);
  if (code === 'ECONNREFUSED') {
    return {
      errorCode: 'CAMERA_DISCONNECTED',
      message: `Camera disconnected — connection refused at ${host}:${port}. Verify the camera/DVR is powered on and port ${port} is open.`,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      errorCode: 'NETWORK_FAILURE',
      message: `Network connection failure — host "${host}" could not be resolved. Check DNS or IP address.`,
    };
  }
  const lanHint = isLan
    ? ' Note: Private LAN cameras (192.168.x.x / 10.x.x.x) cannot be reached directly from a remote cloud server unless port-forwarding, DDNS, VPN, or a local shop gateway is configured.'
    : '';
  return {
    errorCode: 'NETWORK_FAILURE',
    message: `Network connection failure — timed out reaching ${host}:${port}.${lanHint}`,
  };
}

export async function probeCameraConnection(params: {
  cameraType?: CctvCameraType;
  ipAddress?: string;
  port?: number;
  username?: string;
  password?: string;
  streamUrl?: string;
  channelNumber?: number;
  supportsPtz?: boolean;
  supportsAudio?: boolean;
  dvrConfig?: DvrNvrStoredConfig;
  dvrPassword?: string;
}): Promise<CctvConnectionTestResult> {
  const { ffmpegAvailable, ffprobeAvailable } = detectMediaBinaries();
  const resolved = resolveEffectiveCameraTarget(params);

  if (!resolved.ok || !resolved.effectiveUrl || !resolved.host || !resolved.port) {
    return {
      ok: false,
      status: 'offline',
      errorCode: resolved.errorCode || 'INVALID_IP_OR_URL',
      message: resolved.message || 'Invalid IP address or stream URL.',
      capabilities: defaultCapabilitiesForCamera({ cameraType: params.cameraType }, ffmpegAvailable),
    };
  }

  // 1. Real TCP socket reachability check
  const tcp = await checkTcpPort(resolved.host, resolved.port, 3500);
  if (!tcp.ok) {
    const classified = classifyTcpFailure(tcp.code, resolved.host, resolved.port);
    return {
      ok: false,
      status: 'offline',
      errorCode: classified.errorCode,
      message: classified.message,
      latencyMs: tcp.latencyMs,
      capabilities: defaultCapabilitiesForCamera(
        { cameraType: resolved.cameraType, supportsPtz: params.supportsPtz, supportsAudio: params.supportsAudio },
        ffmpegAvailable
      ),
    };
  }

  // 2. HTTP / HTTPS / HLS / MJPEG / WebRTC probing
  if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
    const httpProbe = await probeHttpStream(resolved.effectiveUrl, resolved.username, resolved.password);
    if (httpProbe.statusCode === 401 || httpProbe.statusCode === 403) {
      return {
        ok: false,
        status: 'offline',
        errorCode: 'AUTH_FAILED',
        message: 'Incorrect username or password — camera rejected credentials (HTTP 401/403).',
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }

    if (resolved.cameraType === 'webrtc' && (httpProbe.statusCode === 200 || httpProbe.statusCode === 405)) {
      return {
        ok: true,
        status: 'online',
        errorCode: 'OK',
        message: `Connected to WebRTC (WHEP) gateway (${tcp.latencyMs}ms).`,
        latencyMs: tcp.latencyMs,
        resolution: 'WebRTC Live',
        codec: 'webrtc',
        capabilities: {
          liveVideo: true,
          audio: Boolean(params.supportsAudio),
          snapshot: false,
          ptz: Boolean(params.supportsPtz),
          recording: false,
          playback: false,
          playbackProtocol: 'webrtc',
        },
      };
    }

    if (!httpProbe.ok) {
      if (httpProbe.statusCode === 404 || httpProbe.statusCode === 415) {
        return {
          ok: false,
          status: 'offline',
          errorCode: 'UNSUPPORTED_FORMAT',
          message: `Stream path returned HTTP ${httpProbe.statusCode}. Verify the stream URL or channel path.`,
          latencyMs: tcp.latencyMs,
          capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
        };
      }
      return {
        ok: false,
        status: 'offline',
        errorCode: httpProbe.errorCode === 'ETIMEDOUT' ? 'NETWORK_FAILURE' : 'CAMERA_DISCONNECTED',
        message: httpProbe.errMsg || `Camera disconnected (HTTP ${httpProbe.statusCode || 'unreachable'}).`,
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }

    const ct = httpProbe.contentType;
    const isHls =
      ct.includes('mpegurl') ||
      resolved.effectiveUrl.toLowerCase().includes('.m3u8') ||
      httpProbe.bodySnippet.includes('#EXTM3U');
    const isMjpeg = ct.includes('multipart/x-mixed-replace');
    const isJpeg = ct.includes('image/jpeg');
    const isVideo = ct.includes('video/mp4') || ct.includes('video/webm') || ct.includes('video/quicktime') || ct.includes('application/octet-stream');

    if (ct.includes('text/html') && !isHls && !isMjpeg) {
      return {
        ok: false,
        status: 'offline',
        errorCode: 'UNSUPPORTED_FORMAT',
        message: 'Unsupported stream format — target returned a web page (HTML) instead of a live video stream. Enter an RTSP, HLS (.m3u8), or MJPEG URL.',
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }

    if (!isHls && !isMjpeg && !isJpeg && !isVideo && resolved.cameraType !== 'onvif') {
      return {
        ok: false,
        status: 'offline',
        errorCode: 'UNSUPPORTED_FORMAT',
        message: `Unsupported stream format ("${ct || 'unknown'}"). Expected HLS (.m3u8), MJPEG, or MP4/RTSP stream.`,
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }

    const playbackProtocol: CctvPlaybackProtocol = isHls
      ? 'hls'
      : isMjpeg
      ? 'mjpeg'
      : isJpeg
      ? 'snapshot-poll'
      : isVideo
      ? 'mp4'
      : ffmpegAvailable
      ? 'hls'
      : 'none';

    return {
      ok: true,
      status: 'online',
      errorCode: 'OK',
      message: `Connected cleanly via ${playbackProtocol.toUpperCase()} (${tcp.latencyMs}ms).`,
      latencyMs: tcp.latencyMs,
      resolution: isMjpeg ? 'MJPEG Live' : isHls ? 'HLS Live' : 'HTTP Video',
      codec: playbackProtocol,
      capabilities: {
        liveVideo: true,
        audio: isHls || isVideo ? Boolean(params.supportsAudio) : false,
        snapshot: isMjpeg || isJpeg || ffmpegAvailable,
        ptz: Boolean(params.supportsPtz),
        recording: ffmpegAvailable && playbackProtocol !== 'snapshot-poll',
        playback: ffmpegAvailable,
        playbackProtocol,
      },
    };
  }

  // 3. RTSP / RTSPS / DVR / NVR / ONVIF probing via ffprobe (preferred)
  if (!ffprobeAvailable) {
    return {
      ok: false,
      status: 'offline',
      errorCode: 'GATEWAY_UNAVAILABLE',
      message: 'Streaming server gateway (FFmpeg / FFprobe) is unavailable on this host. Configure an external HLS/WebRTC gateway URL or run on the POS desktop/server gateway.',
      latencyMs: tcp.latencyMs,
      capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, false),
    };
  }

  const probeResult = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-rtsp_transport',
      'tcp',
      '-rw_timeout',
      '4500000',
      '-show_entries',
      'stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      resolved.effectiveUrl,
    ],
    6500
  );

  if (!probeResult.ok) {
    const errText = `${probeResult.stderr || ''} ${probeResult.error?.message || ''}`.toLowerCase();
    if (errText.includes('401') || errText.includes('unauthorized') || errText.includes('403') || errText.includes('forbidden')) {
      return {
        ok: false,
        status: 'offline',
        errorCode: 'AUTH_FAILED',
        message: 'Incorrect username or password — RTSP stream authentication failed (401 Unauthorized).',
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }
    if (errText.includes('404') || errText.includes('not found') || errText.includes('invalid data') || errText.includes('415')) {
      return {
        ok: false,
        status: 'offline',
        errorCode: 'UNSUPPORTED_FORMAT',
        message: 'Unsupported stream format or invalid RTSP channel path (404 / Invalid stream).',
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }
    if (errText.includes('refused')) {
      return {
        ok: false,
        status: 'offline',
        errorCode: 'CAMERA_DISCONNECTED',
        message: 'Camera disconnected — RTSP service refused connection.',
        latencyMs: tcp.latencyMs,
        capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
      };
    }
    return {
      ok: false,
      status: 'offline',
      errorCode: 'CAMERA_DISCONNECTED',
      message: `Camera stream unreachable: ${maskCredentialsInUrl(probeResult.stderr.split('\n')[0] || 'RTSP handshake failed')}`,
      latencyMs: tcp.latencyMs,
      capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
    };
  }

  let parsedJson: { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> } = {};
  try {
    parsedJson = JSON.parse(probeResult.stdout || '{}');
  } catch {}

  const streams = Array.isArray(parsedJson.streams) ? parsedJson.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    return {
      ok: false,
      status: 'offline',
      errorCode: 'UNSUPPORTED_FORMAT',
      message: 'Connected to endpoint, but no supported video stream was detected.',
      latencyMs: tcp.latencyMs,
      capabilities: defaultCapabilitiesForCamera({ cameraType: resolved.cameraType }, ffmpegAvailable),
    };
  }

  const resLabel =
    videoStream.width && videoStream.height
      ? `${videoStream.width}×${videoStream.height}`
      : 'HD Live';

  return {
    ok: true,
    status: 'online',
    errorCode: 'OK',
    message: `Connected cleanly (${resLabel}, ${String(videoStream.codec_name || 'video').toUpperCase()}, ${tcp.latencyMs}ms).`,
    latencyMs: tcp.latencyMs,
    resolution: resLabel,
    codec: videoStream.codec_name || 'h264',
    capabilities: {
      liveVideo: ffmpegAvailable,
      audio: Boolean(audioStream),
      snapshot: ffmpegAvailable,
      ptz: Boolean(params.supportsPtz),
      recording: ffmpegAvailable,
      playback: ffmpegAvailable,
      playbackProtocol: ffmpegAvailable ? 'hls' : 'none',
    },
  };
}

export class CctvGatewayManager {
  private readonly dataDir: string;
  private readonly streamsRoot: string;
  private readonly recordingsRoot: string;
  private readonly activeStreams = new Map<string, ActiveHlsWorker>();
  private readonly activeRecordings = new Map<string, ActiveRecordingWorker>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.streamsRoot = path.resolve(this.dataDir, 'cctv_streams');
    this.recordingsRoot = path.resolve(this.dataDir, 'cctv_recordings');
    fs.mkdirSync(this.streamsRoot, { recursive: true });
    fs.mkdirSync(this.recordingsRoot, { recursive: true });
    this.cleanupOrphanedStreamFiles(true);

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleStreams();
      this.cleanupOrphanedStreamFiles(false);
    }, 15_000);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  getGatewayStatus(): CctvGatewayStatus {
    const { ffmpegAvailable, ffprobeAvailable } = detectMediaBinaries();
    return {
      ffmpegAvailable,
      ffprobeAvailable,
      activeStreamsCount: this.activeStreams.size,
      activeRecordingsCount: this.activeRecordings.size,
      cloudEnvironment: Boolean(process.env.K_SERVICE || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
    };
  }

  getActiveRecordingCameraIds(shopId: string): Set<string> {
    const out = new Set<string>();
    for (const rec of this.activeRecordings.values()) {
      if (rec.shopId === shopId && rec.status === 'recording') {
        out.add(rec.cameraId);
      }
    }
    return out;
  }

  private streamKey(shopId: string, cameraId: string): string {
    return `${sanitizeIdSegment(shopId)}::${sanitizeIdSegment(cameraId)}`;
  }

  private cleanupIdleStreams() {
    const cutoff = Date.now() - 45_000;
    for (const [key, worker] of this.activeStreams.entries()) {
      if (worker.lastViewerAt < cutoff) {
        this.stopHlsWorker(key);
      }
    }
  }

  private cleanupOrphanedStreamFiles(cleanAllDirs: boolean) {
    try {
      if (!fs.existsSync(this.streamsRoot)) return;
      const now = Date.now();
      for (const entry of fs.readdirSync(this.streamsRoot, { withFileTypes: true })) {
        const full = resolveConfinedPath(this.streamsRoot, entry.name);
        if (!full) continue;
        try {
          if (entry.isFile() && entry.name.startsWith('snap_') && entry.name.endsWith('.jpg')) {
            const st = fs.statSync(full);
            if (cleanAllDirs || now - st.mtimeMs > 120_000) {
              fs.unlinkSync(full);
            }
          } else if (cleanAllDirs && entry.isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch {}
      }
    } catch {}
  }

  shutdownAll() {
    try {
      clearInterval(this.cleanupTimer);
    } catch {}
    for (const key of Array.from(this.activeStreams.keys())) {
      this.stopHlsWorker(key);
    }
    for (const [recId, rec] of Array.from(this.activeRecordings.entries())) {
      this.activeRecordings.delete(recId);
      try {
        rec.proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (!rec.proc.killed) rec.proc.kill('SIGKILL');
          } catch {}
        }, 800).unref();
      } catch {}
    }
  }

  stopCameraWorkers(shopId: string, cameraId: string) {
    const key = this.streamKey(shopId, cameraId);
    this.stopHlsWorker(key);
    const activeRec = Array.from(this.activeRecordings.values()).find(
      (r) => r.shopId === shopId && r.cameraId === cameraId
    );
    if (activeRec) {
      this.stopRecording(shopId, activeRec.id).catch(() => {});
    }
  }

  private stopHlsWorker(key: string) {
    const worker = this.activeStreams.get(key);
    if (!worker) return;
    this.activeStreams.delete(key);
    try {
      worker.proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!worker.proc.killed) worker.proc.kill('SIGKILL');
        } catch {}
      }, 1000).unref();
    } catch {}
    setTimeout(() => {
      try {
        fs.rmSync(worker.dir, { recursive: true, force: true });
      } catch {}
    }, 1200).unref();
  }

  private buildFfmpegInputArgs(targetUrl: string, fallbackUsername?: string, fallbackPassword?: string): string[] {
    const lower = targetUrl.toLowerCase();
    if (lower.startsWith('rtsp:') || lower.startsWith('rtsps:')) {
      return ['-rtsp_transport', 'tcp', '-rw_timeout', '5000000', '-i', targetUrl];
    }
    if (lower.startsWith('http:') || lower.startsWith('https:')) {
      try {
        const parsed = new URL(targetUrl);
        const safeDecode = (val: string) => {
          try {
            return decodeURIComponent(val);
          } catch {
            return val;
          }
        };
        const user = parsed.username ? safeDecode(parsed.username) : String(fallbackUsername || '');
        const pass = parsed.password ? safeDecode(parsed.password) : String(fallbackPassword || '');
        if (user || pass) {
          const clean = new URL(parsed.toString());
          clean.username = '';
          clean.password = '';
          const auth = Buffer.from(`${user}:${pass}`).toString('base64');
          return ['-headers', `Authorization: Basic ${auth}\r\n`, '-i', clean.toString()];
        }
      } catch {
        // Fallback to raw targetUrl if parsing fails
      }
    }
    return ['-i', targetUrl];
  }

  async ensureHlsPlaylist(params: {
    shopId: string;
    camera: CctvCameraStored;
    targetUrl: string;
    codecHint?: string;
  }): Promise<{ ok: boolean; playlistPath?: string; message?: string; errorCode?: CctvErrorCode }> {
    const { ffmpegAvailable } = detectMediaBinaries();
    if (!ffmpegAvailable) {
      return {
        ok: false,
        errorCode: 'GATEWAY_UNAVAILABLE',
        message: 'Streaming server (FFmpeg gateway) is unavailable on this host.',
      };
    }

    const safeShop = sanitizeIdSegment(params.shopId);
    const safeCam = sanitizeIdSegment(params.camera.id);
    if (!safeShop || !safeCam) {
      return { ok: false, errorCode: 'INVALID_IP_OR_URL', message: 'Invalid shop or camera ID.' };
    }

    const key = this.streamKey(safeShop, safeCam);
    const existing = this.activeStreams.get(key);
    if (existing) {
      existing.lastViewerAt = Date.now();
      const m3u8 = path.join(existing.dir, 'stream.m3u8');
      if (fs.existsSync(m3u8)) {
        return { ok: true, playlistPath: m3u8 };
      }
      if (existing.failedReason) {
        const reason = existing.failedReason;
        this.stopHlsWorker(key);
        return { ok: false, errorCode: 'CAMERA_DISCONNECTED', message: reason };
      }
      // Still starting up — wait briefly below
    }

    let worker = existing;
    if (!worker) {
      const streamDir = resolveConfinedPath(this.streamsRoot, safeShop, safeCam);
      if (!streamDir) {
        return { ok: false, errorCode: 'INVALID_IP_OR_URL', message: 'Invalid stream workspace path.' };
      }
      fs.rmSync(streamDir, { recursive: true, force: true });
      fs.mkdirSync(streamDir, { recursive: true });

      const m3u8Path = path.join(streamDir, 'stream.m3u8');
      const segPattern = path.join(streamDir, 'seg_%05d.ts');
      const codecLower = String(params.codecHint || '').toLowerCase();
      const canCopyVideo = codecLower === 'h264';

      const args: string[] = [
        '-y',
        '-loglevel',
        'error',
        ...this.buildFfmpegInputArgs(params.targetUrl),
        ...(canCopyVideo
          ? ['-c:v', 'copy']
          : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '24']),
        ...(params.camera.supportsAudio ? ['-c:a', 'aac', '-b:a', '64k', '-ac', '1'] : ['-an']),
        '-f',
        'hls',
        '-hls_time',
        '1',
        '-hls_list_size',
        '5',
        '-hls_flags',
        'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename',
        segPattern,
        m3u8Path
      ];

      const proc = spawn('ffmpeg', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      worker = {
        key,
        shopId: safeShop,
        cameraId: safeCam,
        dir: streamDir,
        proc,
        startedAt: Date.now(),
        lastViewerAt: Date.now(),
        sourceUrl: params.targetUrl,
        ready: false,
      };
      this.activeStreams.set(key, worker);

      let stderrTail = '';
      proc.stderr?.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString('utf8')).slice(-800);
      });
      proc.on('exit', (code) => {
        const current = this.activeStreams.get(key);
        if (current && current.proc === proc) {
          if (code !== 0 && !current.ready) {
            current.failedReason = maskCredentialsInUrl(stderrTail.trim() || `Stream gateway exited (${code}).`);
          }
        }
      });
    }

    const playlistFile = path.join(worker.dir, 'stream.m3u8');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (fs.existsSync(playlistFile) && fs.statSync(playlistFile).size > 20) {
        worker.ready = true;
        worker.lastViewerAt = Date.now();
        return { ok: true, playlistPath: playlistFile };
      }
      if (worker.failedReason) {
        const msg = worker.failedReason;
        this.stopHlsWorker(key);
        return { ok: false, errorCode: 'CAMERA_DISCONNECTED', message: msg };
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return {
      ok: false,
      errorCode: 'NETWORK_FAILURE',
      message: 'Timed out waiting for live HLS segments from camera.',
    };
  }

  getHlsSegmentPath(shopId: string, cameraId: string, fileName: string): string | null {
    const safeShop = sanitizeIdSegment(shopId);
    const safeCam = sanitizeIdSegment(cameraId);
    const cleanFile = path.basename(String(fileName || ''));
    if (!safeShop || !safeCam || !/^[a-zA-Z0-9_.-]+\.(ts|m4s|mp4)$/.test(cleanFile)) {
      return null;
    }
    const key = this.streamKey(safeShop, safeCam);
    const worker = this.activeStreams.get(key);
    if (worker) worker.lastViewerAt = Date.now();
    const resolved = resolveConfinedPath(this.streamsRoot, safeShop, safeCam, cleanFile);
    if (!resolved || !fs.existsSync(resolved)) return null;
    return resolved;
  }

  async captureSnapshotJpeg(targetUrl: string, username?: string, password?: string): Promise<{ ok: boolean; jpeg?: Buffer; errorCode?: CctvErrorCode; message?: string }> {
    const { ffmpegAvailable } = detectMediaBinaries();

    if ((targetUrl.startsWith('http:') || targetUrl.startsWith('https:')) && !targetUrl.includes('.m3u8')) {
      const quick = await new Promise<{ ok: boolean; buf?: Buffer; ct: string; status: number }>((resolve) => {
        try {
          const parsed = new URL(targetUrl);
          const client = parsed.protocol === 'https:' ? https : http;
          const clean = new URL(parsed.toString());
          clean.username = '';
          clean.password = '';
          const headers: Record<string, string> = {};
          if (username || password) {
            headers['Authorization'] = `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;
          }
          const req = client.get(clean, { headers, timeout: 4000 }, (res) => {
            const ct = String(res.headers['content-type'] || '').toLowerCase();
            if ((res.statusCode || 0) === 200 && ct.includes('image/jpeg')) {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => resolve({ ok: true, buf: Buffer.concat(chunks), ct, status: 200 }));
            } else {
              res.destroy();
              resolve({ ok: false, ct, status: res.statusCode || 0 });
            }
          });
          req.on('error', () => resolve({ ok: false, ct: '', status: 0 }));
        } catch {
          resolve({ ok: false, ct: '', status: 0 });
        }
      });
      if (quick.ok && quick.buf && quick.buf.length > 100) {
        return { ok: true, jpeg: quick.buf };
      }
    }

    if (!ffmpegAvailable) {
      return {
        ok: false,
        errorCode: 'GATEWAY_UNAVAILABLE',
        message: 'Snapshot capture requires FFmpeg gateway or a direct JPEG/MJPEG camera endpoint.',
      };
    }

    const tmpFile = path.join(this.streamsRoot, `snap_${crypto.randomBytes(8).toString('hex')}.jpg`);
    const args: string[] = [
      '-y',
      '-loglevel',
      'error',
      ...this.buildFfmpegInputArgs(targetUrl, username, password),
      '-frames:v',
      '1',
      '-q:v',
      '3',
      tmpFile,
    ];

    const res = await execFileAsync('ffmpeg', args, 7500);
    try {
      if (res.ok && fs.existsSync(tmpFile)) {
        const buf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        if (buf.length > 0) return { ok: true, jpeg: buf };
      }
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}

    return {
      ok: false,
      errorCode: 'CAMERA_DISCONNECTED',
      message: maskCredentialsInUrl(res.stderr || 'Could not capture snapshot frame from camera.'),
    };
  }

  async sendPtzCommand(params: {
    host: string;
    port: number;
    cameraType: CctvCameraType;
    username?: string;
    password?: string;
    action: CctvPtzAction;
    speed?: number;
  }): Promise<{ ok: boolean; message: string; errorCode?: CctvErrorCode }> {
    const speed = Math.min(1, Math.max(0.1, Number(params.speed) || 0.5));
    let pan = 0;
    let tilt = 0;
    let zoom = 0;
    if (params.action === 'left') pan = -speed;
    if (params.action === 'right') pan = speed;
    if (params.action === 'up') tilt = speed;
    if (params.action === 'down') tilt = -speed;
    if (params.action === 'zoom_in') zoom = speed;
    if (params.action === 'zoom_out') zoom = -speed;

    const httpPort = params.port === 554 ? 80 : params.port || 80;
    const scheme = httpPort === 443 ? 'https' : 'http';
    const baseHost = params.host.includes(':') ? `[${params.host}]` : params.host;
    const onvifUrl = `${scheme}://${baseHost}:${httpPort}/onvif/ptz_service`;

    const nonce = crypto.randomBytes(16);
    const created = new Date().toISOString();
    const sha1Digest = crypto
      .createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(params.password || '', 'utf8')]))
      .digest('base64');

    const securityHeader = params.username
      ? `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${escapeXml(params.username)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${sha1Digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`
      : '';

    const soapBody =
      params.action === 'stop'
        ? `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`
        : `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>Profile_1</ProfileToken><Velocity><PanTilt x="${pan}" y="${tilt}" xmlns="http://www.onvif.org/ver10/schema"/><Zoom x="${zoom}" xmlns="http://www.onvif.org/ver10/schema"/></Velocity></ContinuousMove>`;

    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${securityHeader}<s:Body>${soapBody}</s:Body></s:Envelope>`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const headers: Record<string, string> = {
        'Content-Type': 'application/soap+xml; charset=utf-8',
      };
      if (params.username || params.password) {
        headers['Authorization'] = `Basic ${Buffer.from(`${params.username || ''}:${params.password || ''}`).toString('base64')}`;
      }
      const res = await fetch(onvifUrl, {
        method: 'POST',
        headers,
        body: envelope,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          errorCode: 'AUTH_FAILED',
          message: 'PTZ rejected: Incorrect camera username or password (HTTP 401/403).',
        };
      }
      if (res.ok) {
        return { ok: true, message: `PTZ command (${params.action}) delivered.` };
      }
      return {
        ok: false,
        errorCode: 'UNSUPPORTED_FORMAT',
        message: `Camera returned HTTP ${res.status} for ONVIF PTZ request.`,
      };
    } catch (err: any) {
      return {
        ok: false,
        errorCode: 'NETWORK_FAILURE',
        message: `Could not reach PTZ service at ${onvifUrl}: ${err?.message || 'Timeout'}`,
      };
    }
  }

  startRecording(params: {
    shopId: string;
    camera: CctvCameraStored;
    targetUrl: string;
    trigger?: 'manual' | 'scheduled' | 'continuous' | 'motion';
  }): { ok: boolean; recording?: CctvRecordingEntry; errorCode?: CctvErrorCode; message?: string } {
    const { ffmpegAvailable } = detectMediaBinaries();
    if (!ffmpegAvailable) {
      return {
        ok: false,
        errorCode: 'GATEWAY_UNAVAILABLE',
        message: 'Server recording requires FFmpeg gateway.',
      };
    }
    const safeShop = sanitizeIdSegment(params.shopId);
    const safeCam = sanitizeIdSegment(params.camera.id);
    if (!safeShop || !safeCam) {
      return { ok: false, errorCode: 'INVALID_IP_OR_URL', message: 'Invalid camera/shop identifier.' };
    }

    const already = Array.from(this.activeRecordings.values()).find(
      (r) => r.shopId === safeShop && r.cameraId === safeCam && r.status === 'recording'
    );
    if (already) {
      return {
        ok: true,
        recording: {
          id: already.id,
          cameraId: already.cameraId,
          cameraName: already.cameraName,
          startedAt: already.startedAt,
          sizeBytes: fs.existsSync(already.filePath) ? fs.statSync(already.filePath).size : 0,
          trigger: already.trigger,
          status: 'recording',
        },
      };
    }

    const camRecDir = resolveConfinedPath(this.recordingsRoot, safeShop, safeCam);
    if (!camRecDir) {
      return { ok: false, errorCode: 'INVALID_IP_OR_URL', message: 'Invalid recording path.' };
    }
    fs.mkdirSync(camRecDir, { recursive: true });

    const recId = `rec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const fileName = `${recId}.mp4`;
    const filePath = resolveConfinedPath(camRecDir, fileName);
    const metaPath = resolveConfinedPath(camRecDir, `${recId}.meta.json`);
    if (!filePath || !metaPath) {
      return { ok: false, errorCode: 'INVALID_IP_OR_URL', message: 'Invalid recording filename.' };
    }

    const args = [
      '-y',
      '-loglevel',
      'error',
      ...this.buildFfmpegInputArgs(params.targetUrl),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '1800', // safety cap 30 min per clip
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      filePath
    ];

    const proc = spawn('ffmpeg', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const startedAt = new Date().toISOString();
    const trigger = params.trigger || 'manual';
    try {
      fs.writeFileSync(
        metaPath,
        JSON.stringify({ id: recId, cameraId: safeCam, cameraName: params.camera.name, startedAt, trigger })
      );
    } catch {}

    const worker: ActiveRecordingWorker = {
      id: recId,
      shopId: safeShop,
      cameraId: safeCam,
      cameraName: params.camera.name,
      filePath,
      metaPath,
      fileName,
      proc,
      startedAt,
      trigger,
      status: 'recording',
    };
    this.activeRecordings.set(recId, worker);

    proc.on('exit', () => {
      const current = this.activeRecordings.get(recId);
      if (current) {
        current.status = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? 'ready' : 'failed';
        const endedAt = new Date().toISOString();
        const durationSec = Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
        try {
          fs.writeFileSync(
            metaPath,
            JSON.stringify({ id: recId, cameraId: safeCam, cameraName: params.camera.name, startedAt, endedAt, durationSec, trigger })
          );
        } catch {}
        this.activeRecordings.delete(recId);
      }
    });

    return {
      ok: true,
      recording: {
        id: recId,
        cameraId: safeCam,
        cameraName: params.camera.name,
        startedAt,
        sizeBytes: 0,
        trigger,
        status: 'recording',
      },
    };
  }

  async stopRecording(shopId: string, recordingId: string): Promise<{ ok: boolean; recording?: CctvRecordingEntry }> {
    const safeShop = sanitizeIdSegment(shopId);
    const worker = this.activeRecordings.get(recordingId);
    if (!worker || worker.shopId !== safeShop) {
      const existingFile = this.resolveRecordingFile(shopId, recordingId);
      if (!existingFile) {
        return { ok: false };
      }
      const st = fs.statSync(existingFile);
      const cameraId = path.basename(path.dirname(existingFile));
      const meta = this.readRecordingMeta(existingFile);
      const startedAt = meta?.startedAt || st.birthtime.toISOString();
      const endedAt = meta?.endedAt || st.mtime.toISOString();
      const durationSec =
        meta?.durationSec ?? Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
      return {
        ok: true,
        recording: {
          id: sanitizeIdSegment(recordingId),
          cameraId,
          cameraName: meta?.cameraName || cameraId,
          startedAt,
          endedAt,
          durationSec,
          sizeBytes: st.size,
          trigger: meta?.trigger || 'manual',
          status: st.size > 0 ? 'ready' : 'failed',
        },
      };
    }
    this.activeRecordings.delete(recordingId);
    try {
      worker.proc.kill('SIGINT');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            worker.proc.kill('SIGKILL');
          } catch {}
          resolve();
        }, 1800);
        worker.proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {}
    const sizeBytes = fs.existsSync(worker.filePath) ? fs.statSync(worker.filePath).size : 0;
    const endedAt = new Date().toISOString();
    const durationSec = Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(worker.startedAt)) / 1000));
    try {
      fs.writeFileSync(
        worker.metaPath,
        JSON.stringify({
          id: worker.id,
          cameraId: worker.cameraId,
          cameraName: worker.cameraName,
          startedAt: worker.startedAt,
          endedAt,
          durationSec,
          trigger: worker.trigger,
        })
      );
    } catch {}
    return {
      ok: true,
      recording: {
        id: worker.id,
        cameraId: worker.cameraId,
        cameraName: worker.cameraName,
        startedAt: worker.startedAt,
        endedAt,
        durationSec,
        sizeBytes,
        trigger: worker.trigger,
        status: sizeBytes > 0 ? 'ready' : 'failed',
      },
    };
  }

  private readRecordingMeta(mp4Path: string): {
    cameraName?: string;
    startedAt?: string;
    endedAt?: string;
    durationSec?: number;
    trigger?: 'manual' | 'scheduled' | 'continuous' | 'motion';
  } | null {
    try {
      const metaPath = mp4Path.replace(/\.mp4$/, '.meta.json');
      if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    } catch {}
    return null;
  }

  listRecordings(
    shopId: string,
    cameraId?: string,
    cameraNameMap?: Map<string, string>,
    filters?: { date?: string; fromTime?: string; toTime?: string }
  ): CctvRecordingEntry[] {
    const safeShop = sanitizeIdSegment(shopId);
    const shopDir = resolveConfinedPath(this.recordingsRoot, safeShop);
    if (!shopDir || !fs.existsSync(shopDir)) return [];

    const results: CctvRecordingEntry[] = [];
    const camDirs = cameraId ? [sanitizeIdSegment(cameraId)] : fs.readdirSync(shopDir);
    for (const camDirName of camDirs) {
      if (!camDirName) continue;
      const fullCamDir = resolveConfinedPath(shopDir, camDirName);
      if (!fullCamDir || !fs.existsSync(fullCamDir) || !fs.statSync(fullCamDir).isDirectory()) continue;
      for (const file of fs.readdirSync(fullCamDir)) {
        if (!/^[a-zA-Z0-9_.-]+\.mp4$/.test(file)) continue;
        const fullFile = resolveConfinedPath(fullCamDir, file);
        if (!fullFile) continue;
        const recId = file.replace(/\.mp4$/, '');
        const active = this.activeRecordings.get(recId);
        const st = fs.statSync(fullFile);
        const meta = active ? null : this.readRecordingMeta(fullFile);
        const startedAt = active ? active.startedAt : meta?.startedAt || st.birthtime.toISOString();
        const endedAt = active ? undefined : meta?.endedAt || st.mtime.toISOString();
        const durationSec = active
          ? Math.max(1, Math.round((Date.now() - Date.parse(active.startedAt)) / 1000))
          : meta?.durationSec ?? Math.max(1, Math.round((st.mtimeMs - st.birthtimeMs) / 1000));

        if (filters?.date) {
          const d = new Date(startedAt);
          const localYmd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const utcYmd = startedAt.slice(0, 10);
          if (localYmd !== filters.date && utcYmd !== filters.date) continue;
        }
        if (filters?.fromTime || filters?.toTime) {
          const d = new Date(startedAt);
          const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          if (filters.fromTime && hhmm < filters.fromTime) continue;
          if (filters.toTime && hhmm > filters.toTime) continue;
        }

        results.push({
          id: recId,
          cameraId: camDirName,
          cameraName: cameraNameMap?.get(camDirName) || meta?.cameraName || camDirName,
          startedAt,
          endedAt,
          durationSec,
          sizeBytes: st.size,
          trigger: active ? active.trigger : meta?.trigger || 'manual',
          status: active ? 'recording' : st.size > 0 ? 'ready' : 'failed',
        });
      }
    }
    return results.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  getStorageMetrics(
    shopId: string,
    settings: CctvSystemSettings,
    cameraNameMap?: Map<string, string>
  ): CctvStorageSummary {
    const recordings = this.listRecordings(shopId, undefined, cameraNameMap);
    let usedBytes = 0;
    const perCamMap = new Map<string, { cameraId: string; cameraName: string; usedBytes: number; recordingsCount: number }>();

    for (const rec of recordings) {
      usedBytes += rec.sizeBytes || 0;
      const prev = perCamMap.get(rec.cameraId) || {
        cameraId: rec.cameraId,
        cameraName: rec.cameraName,
        usedBytes: 0,
        recordingsCount: 0,
      };
      prev.usedBytes += rec.sizeBytes || 0;
      prev.recordingsCount += 1;
      perCamMap.set(rec.cameraId, prev);
    }

    let availableBytes: number | null = null;
    let totalDiskBytes: number | null = null;
    try {
      const fsAny = fs as any;
      if (typeof fsAny.statfsSync === 'function') {
        const statfs = fsAny.statfsSync(this.recordingsRoot);
        if (statfs && statfs.bsize && statfs.blocks) {
          totalDiskBytes = Number(statfs.blocks) * Number(statfs.bsize);
          availableBytes = Number(statfs.bavail ?? statfs.bfree) * Number(statfs.bsize);
        }
      }
    } catch {}

    const maxStorageBytes = (settings.storage.maxStorageMb || 2048) * 1024 * 1024;
    const denominator = maxStorageBytes > 0 ? maxStorageBytes : totalDiskBytes || 1;
    const usagePercent = Math.min(100, Math.round((usedBytes / denominator) * 1000) / 10);

    return {
      usedBytes,
      availableBytes,
      totalDiskBytes,
      maxStorageMb: settings.storage.maxStorageMb,
      retentionDays: settings.storage.retentionDays,
      autoDeleteExpired: settings.storage.autoDeleteExpired,
      warningThresholdPercent: settings.storage.warningThresholdPercent,
      warningTriggered: usagePercent >= (settings.storage.warningThresholdPercent || 80),
      usagePercent,
      recordingsCount: recordings.length,
      perCamera: Array.from(perCamMap.values()).sort((a, b) => b.usedBytes - a.usedBytes),
    };
  }

  cleanupOldRecordings(
    shopId: string,
    options: { olderThanDays?: number; recordingIds?: string[] }
  ): { deletedCount: number; freedBytes: number; deletedIds: string[] } {
    const recordings = this.listRecordings(shopId);
    const idSet = Array.isArray(options.recordingIds) && options.recordingIds.length > 0
      ? new Set(options.recordingIds.map((id) => sanitizeIdSegment(id)))
      : null;
    const cutoffMs =
      typeof options.olderThanDays === 'number' && options.olderThanDays >= 0
        ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
        : null;

    let deletedCount = 0;
    let freedBytes = 0;
    const deletedIds: string[] = [];

    for (const rec of recordings) {
      if (rec.status === 'recording') continue;
      let shouldDelete = false;
      if (idSet && idSet.has(rec.id)) {
        shouldDelete = true;
      } else if (cutoffMs !== null && Date.parse(rec.startedAt) <= cutoffMs) {
        shouldDelete = true;
      }
      if (shouldDelete) {
        const size = rec.sizeBytes || 0;
        if (this.deleteRecording(shopId, rec.id)) {
          deletedCount += 1;
          freedBytes += size;
          deletedIds.push(rec.id);
        }
      }
    }

    return { deletedCount, freedBytes, deletedIds };
  }

  async detectRealFrameMotion(params: {
    targetUrl: string;
    sensitivity: number;
    username?: string;
    password?: string;
  }): Promise<{
    ok: boolean;
    detected: boolean;
    confidenceScore: number;
    message: string;
    errorCode?: CctvErrorCode;
  }> {
    const { ffmpegAvailable } = detectMediaBinaries();
    if (!ffmpegAvailable) {
      return {
        ok: false,
        detected: false,
        confidenceScore: 0,
        errorCode: 'GATEWAY_UNAVAILABLE',
        message: 'Real-time frame motion analysis requires FFmpeg gateway.',
      };
    }

    // Sensitivity 1..100 maps inversely to scene change threshold (0.35 strict .. 0.02 sensitive)
    const clamped = Math.max(1, Math.min(100, Number(params.sensitivity) || 60));
    const threshold = Math.max(0.02, Math.min(0.4, 0.36 - (clamped / 100) * 0.33)).toFixed(3);

    const args = [
      '-y',
      '-t',
      '2',
      ...this.buildFfmpegInputArgs(params.targetUrl, params.username, params.password),
      '-vf',
      `select='gt(scene,${threshold})',showinfo`,
      '-f',
      'null',
      '-',
    ];

    const res = await execFileAsync('ffmpeg', args, 9000);
    if (!res.ok) {
      return {
        ok: false,
        detected: false,
        confidenceScore: 0,
        errorCode: 'CAMERA_DISCONNECTED',
        message: maskCredentialsInUrl(res.stderr.split('\n')[0] || 'Could not analyze live camera frames.'),
      };
    }

    const lines = `${res.stderr}\n${res.stdout}`.split('\n');
    const matches = lines.filter((l) => l.includes('Parsed_showinfo') && l.includes('n:'));
    if (matches.length > 0) {
      const score = Math.min(100, Math.max(25, Math.round(clamped * 0.65 + matches.length * 10)));
      return {
        ok: true,
        detected: true,
        confidenceScore: score,
        message: `Genuine frame motion detected (${matches.length} frame change${matches.length > 1 ? 's' : ''} above threshold ${threshold}).`,
      };
    }

    return {
      ok: true,
      detected: false,
      confidenceScore: 0,
      message: `No significant frame motion detected across sampled frames (threshold ${threshold}).`,
    };
  }

  resolveRecordingFile(shopId: string, recordingId: string): string | null {
    const safeShop = sanitizeIdSegment(shopId);
    const safeRec = sanitizeIdSegment(recordingId);
    const shopDir = resolveConfinedPath(this.recordingsRoot, safeShop);
    if (!shopDir || !safeRec || !fs.existsSync(shopDir)) return null;
    for (const camDirName of fs.readdirSync(shopDir)) {
      const candidate = resolveConfinedPath(shopDir, camDirName, `${safeRec}.mp4`);
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  deleteRecording(shopId: string, recordingId: string): boolean {
    const active = this.activeRecordings.get(recordingId);
    if (active && active.shopId === sanitizeIdSegment(shopId)) {
      try {
        active.proc.kill('SIGKILL');
      } catch {}
      this.activeRecordings.delete(recordingId);
    }
    const file = this.resolveRecordingFile(shopId, recordingId);
    if (!file) return false;
    fs.unlinkSync(file);
    try {
      const meta = file.replace(/\.mp4$/, '.meta.json');
      if (fs.existsSync(meta)) fs.unlinkSync(meta);
    } catch {}
    return true;
  }
}

function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
