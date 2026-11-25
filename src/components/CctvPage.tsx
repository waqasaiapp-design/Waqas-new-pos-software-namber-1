import React, { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  Video,
  Maximize2,
  Minimize2,
  RefreshCw,
  Plus,
  Trash2,
  Edit2,
  AlertCircle,
  CheckCircle2,
  Wifi,
  WifiOff,
  Server,
  Camera,
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Search,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  Circle,
  Square,
  Film,
  Sliders,
  ShieldAlert,
  Loader2,
  MapPin,
  HardDrive,
  Activity,
  Bell,
  Clock,
  Lock,
  Unlock,
  Download,
  Upload,
  FolderPlus,
  RotateCcw,
  FastForward,
  Rewind,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Calendar,
  Cpu,
} from 'lucide-react';
import {
  CctvCamera,
  CctvCameraInput,
  CctvCameraType,
  CctvConnectionTestResult,
  CctvGatewayStatus,
  CctvMotionEvent,
  CctvRecordingEntry,
  CctvRecordingMode,
  CctvStorageSummary,
  CctvSystemSettings,
  DvrNvrConfig,
  UserRole,
} from '../types/pos';
import { FullScreenPageHeader } from './FullScreenPageHeader';
import {
  captureCameraSnapshotBlob,
  cleanupCctvStorageApi,
  clearMotionEventsApi,
  createCameraApi,
  createCctvGroupApi,
  deleteCameraApi,
  deleteCameraRecordingApi,
  deleteCctvGroupApi,
  exportCctvBackupApi,
  fetchAuthorizedRecordingBlobUrl,
  fetchCctvOverview,
  importCctvBackupApi,
  listCameraRecordingsApi,
  listFilteredRecordingsApi,
  refreshAllCamerasApi,
  refreshCameraApi,
  resolveCctvMediaUrl,
  runCameraMotionCheckApi,
  saveCctvSettingsApi,
  saveDvrConfigApi,
  sendCameraPtzApi,
  startCameraRecordingApi,
  startCameraStreamSessionApi,
  stopCameraRecordingApi,
  syncRecordingSchedulesApi,
  testCameraConnectionApi,
  updateCameraApi,
  verifyCctvPinApi,
} from '../utils/cctvClient';

interface CctvPageProps {
  cameras: CctvCamera[];
  dvrConfig: DvrNvrConfig;
  activeShopId?: string;
  userRole?: UserRole;
  canManage?: boolean;
  onSyncCameras: (cameras: CctvCamera[]) => void;
  onSyncDvrConfig: (config: DvrNvrConfig) => void;
  onBackToHome?: () => void;
}

type GridLayoutMode = '1x1' | '2x2' | '3x3' | '4x4';
type CctvSubView =
  | 'dashboard'
  | 'live'
  | 'cameras'
  | 'recordings'
  | 'playback'
  | 'motion'
  | 'status'
  | 'storage'
  | 'settings';

const CAMERA_TYPE_OPTIONS: Array<{ value: CctvCameraType; label: string; defaultPort: number }> = [
  { value: 'rtsp', label: 'RTSP Camera', defaultPort: 554 },
  { value: 'ip', label: 'IP Camera (HTTP/RTSP)', defaultPort: 80 },
  { value: 'onvif', label: 'ONVIF Camera', defaultPort: 80 },
  { value: 'dvr', label: 'DVR Channel', defaultPort: 554 },
  { value: 'nvr', label: 'NVR Channel', defaultPort: 554 },
  { value: 'hls', label: 'HLS Live Stream (.m3u8)', defaultPort: 80 },
  { value: 'mjpeg', label: 'MJPEG / HTTP Camera', defaultPort: 80 },
  { value: 'webrtc', label: 'WebRTC (WHEP Gateway)', defaultPort: 8889 },
];

const LOCATION_PRESETS = [
  'Cash Counter 01',
  'Cash Counter 02',
  'Main Entrance',
  'Stock Room',
  'Warehouse',
  'Back Exit',
];

const WEEKDAYS = [
  { idx: 0, label: 'Sun' },
  { idx: 1, label: 'Mon' },
  { idx: 2, label: 'Tue' },
  { idx: 3, label: 'Wed' },
  { idx: 4, label: 'Thu' },
  { idx: 5, label: 'Fri' },
  { idx: 6, label: 'Sat' },
];

const DEFAULT_SETTINGS_CLIENT: CctvSystemSettings = {
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

function getFriendlyErrorLabel(code?: string): string {
  switch (code) {
    case 'AUTH_FAILED':
      return 'Incorrect Username or Password';
    case 'INVALID_IP_OR_URL':
      return 'Invalid IP Address / Stream URL';
    case 'UNSUPPORTED_FORMAT':
      return 'Unsupported Stream Format';
    case 'GATEWAY_UNAVAILABLE':
      return 'Streaming Gateway Unavailable';
    case 'NETWORK_FAILURE':
      return 'Network Connection Failure';
    case 'CAMERA_DISCONNECTED':
      return 'Camera Disconnected';
    default:
      return 'Connection Error';
  }
}

function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes || 0);
  if (b <= 0) return '0 KB';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const s = Math.floor(seconds);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

interface LivePlayerViewProps {
  camera: CctvCamera;
  shopId?: string;
  isActiveView: boolean;
  muted: boolean;
  paused: boolean;
  refreshSignal: number;
  videoElRef?: React.MutableRefObject<HTMLVideoElement | null>;
  onCameraUpdated: (cam: CctvCamera) => void;
  onAudioAvailabilityChange?: (hasAudio: boolean) => void;
  onToast: (msg: string, tone?: 'ok' | 'err') => void;
}

const LiveCameraFeed: React.FC<LivePlayerViewProps> = ({
  camera,
  shopId,
  isActiveView,
  muted,
  paused,
  refreshSignal,
  videoElRef,
  onCameraUpdated,
  onAudioAvailabilityChange,
  onToast,
}) => {
  const internalVideoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamProtocol, setStreamProtocol] = useState<string>('none');
  const [streamSrc, setStreamSrc] = useState<string>('');
  const [snapshotTick, setSnapshotTick] = useState(0);
  const [liveConnected, setLiveConnected] = useState(false);

  const attachVideoRef = (el: HTMLVideoElement | null) => {
    internalVideoRef.current = el;
    if (videoElRef) videoElRef.current = el;
  };

  const cleanupPlayers = () => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {}
      hlsRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
  };

  const connectStream = async () => {
    cleanupPlayers();
    setLoading(true);
    setStreamError(null);
    setLiveConnected(false);

    try {
      const session = await startCameraStreamSessionApi(camera.id, shopId);
      onCameraUpdated(session.camera);
      setStreamProtocol(session.protocol);
      setStreamSrc(session.streamPath);
      onAudioAvailabilityChange?.(Boolean(session.capabilities?.audio));
      setLoading(false);
    } catch (err: any) {
      setLoading(false);
      setLiveConnected(false);
      const updatedCam = err?.data?.camera as CctvCamera | undefined;
      if (updatedCam) onCameraUpdated(updatedCam);
      setStreamError(err?.message || camera.lastError || 'Camera disconnected or unreachable.');
    }
  };

  useEffect(() => {
    if (!isActiveView && camera.status !== 'online') {
      cleanupPlayers();
      setStreamSrc('');
      setLiveConnected(false);
      setStreamError(camera.lastError || null);
      return;
    }
    connectStream();
    return () => {
      cleanupPlayers();
    };
  }, [camera.id, isActiveView, refreshSignal]);

  useEffect(() => {
    if (streamProtocol !== 'snapshot-poll' || !streamSrc || paused) return;
    const id = window.setInterval(() => {
      setSnapshotTick((t) => t + 1);
    }, 2000);
    return () => window.clearInterval(id);
  }, [streamProtocol, streamSrc, paused]);

  useEffect(() => {
    const videoEl = internalVideoRef.current;
    if (!videoEl || !streamSrc) return;
    if (streamProtocol === 'mjpeg' || streamProtocol === 'snapshot-poll') return;

    cleanupPlayers();
    let cancelled = false;

    const attach = async () => {
      if (streamProtocol === 'hls') {
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 10,
          });
          hlsRef.current = hls;
          hls.loadSource(streamSrc);
          hls.attachMedia(videoEl);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            setLiveConnected(true);
            setStreamError(null);
            if (!paused) videoEl.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (!data.fatal || cancelled) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              setStreamError('Live stream interrupted (network/camera unreachable). Click Retry.');
              setLiveConnected(false);
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              setStreamError('Unsupported video stream format or codec error.');
              setLiveConnected(false);
              hls.destroy();
            }
          });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = streamSrc;
          setLiveConnected(true);
          if (!paused) videoEl.play().catch(() => {});
        } else {
          setStreamError('Browser does not support HLS live playback.');
        }
      } else if (streamProtocol === 'mp4') {
        videoEl.src = streamSrc;
        videoEl.onloadeddata = () => {
          if (!cancelled) {
            setLiveConnected(true);
            setStreamError(null);
          }
        };
        videoEl.onerror = () => {
          if (!cancelled) {
            setLiveConnected(false);
            setStreamError('Camera HTTP video stream disconnected or unsupported codec.');
          }
        };
        if (!paused) videoEl.play().catch(() => {});
      } else if (streamProtocol === 'webrtc') {
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          pcRef.current = pc;
          pc.addTransceiver('video', { direction: 'recvonly' });
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.ontrack = (evt) => {
            if (cancelled) return;
            if (evt.streams?.[0]) {
              videoEl.srcObject = evt.streams[0];
              setLiveConnected(true);
              setStreamError(null);
              if (!paused) videoEl.play().catch(() => {});
            }
          };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const resp = await fetch(streamSrc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: offer.sdp }),
          });
          const json = await resp.json();
          if (!resp.ok || !json?.sdp) {
            throw new Error(json?.message || 'WebRTC gateway rejected stream offer.');
          }
          await pc.setRemoteDescription({ type: 'answer', sdp: json.sdp });
        } catch (err: any) {
          if (!cancelled) {
            setLiveConnected(false);
            setStreamError(err?.message || 'WebRTC live stream connection failed.');
          }
        }
      }
    };

    attach();
    return () => {
      cancelled = true;
      cleanupPlayers();
    };
  }, [streamSrc, streamProtocol]);

  useEffect(() => {
    const v = internalVideoRef.current;
    if (!v) return;
    v.muted = muted;
  }, [muted]);

  useEffect(() => {
    const v = internalVideoRef.current;
    if (!v || !streamSrc) return;
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, [paused, streamSrc]);

  const handleManualTest = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      const res = await refreshCameraApi(camera.id, shopId);
      onCameraUpdated(res.camera);
      if (res.ok) {
        onToast(`${camera.name}: ${res.result.message}`, 'ok');
        await connectStream();
      } else {
        setStreamError(res.result.message);
        onToast(res.result.message, 'err');
      }
    } catch (err: any) {
      setStreamError(err?.message || 'Connection test failed.');
      onToast(err?.message || 'Connection test failed.', 'err');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 p-4 text-center">
        <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mb-2" />
        <p className="text-xs font-semibold text-white">Connecting to {camera.name}...</p>
        <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
          {camera.cameraType.toUpperCase()} · Probing stream
        </p>
      </div>
    );
  }

  if (streamError || !streamSrc) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 p-4 text-center space-y-2.5">
        <div className="w-10 h-10 rounded-xl bg-red-950/60 border border-red-500/30 flex items-center justify-center text-red-400">
          <WifiOff className="w-5 h-5" />
        </div>
        <div className="space-y-1 max-w-md">
          <p className="text-xs font-bold text-red-300 uppercase tracking-wide">
            {getFriendlyErrorLabel(camera.errorCode)}
          </p>
          <p className="text-[11px] text-slate-300 leading-relaxed line-clamp-2">
            {streamError || camera.lastError || 'Camera is offline or unreachable. Click Retry or Test Connection.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => connectStream()}
            className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Retry Stream</span>
          </button>
          <button
            type="button"
            onClick={handleManualTest}
            className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-[11px] font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Wifi className="w-3 h-3 text-emerald-400" />
            <span>Test Connection</span>
          </button>
        </div>
      </div>
    );
  }

  if (streamProtocol === 'mjpeg' || streamProtocol === 'snapshot-poll') {
    const imgUrl =
      streamProtocol === 'snapshot-poll'
        ? `${streamSrc}${streamSrc.includes('?') ? '&' : '?'}_t=${snapshotTick}`
        : streamSrc;
    return (
      <div className="w-full h-full bg-black relative flex items-center justify-center overflow-hidden">
        <img
          src={resolveCctvMediaUrl(imgUrl)}
          alt={camera.name}
          onLoad={() => setLiveConnected(true)}
          onError={() => {
            setLiveConnected(false);
            setStreamError('Camera disconnected or stream format rejected by browser.');
          }}
          className="w-full h-full object-contain"
        />
        {!liveConnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-slate-300">
            Loading live camera frames...
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-black relative flex items-center justify-center overflow-hidden">
      <video
        ref={attachVideoRef}
        playsInline
        autoPlay
        muted={muted}
        controls={false}
        className="w-full h-full object-contain"
      />
      {!liveConnected && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-xs text-slate-300 pointer-events-none">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin mb-1.5" />
          <span>Buffering live video...</span>
        </div>
      )}
    </div>
  );
};

export const CctvPage: React.FC<CctvPageProps> = ({
  cameras,
  dvrConfig,
  activeShopId,
  userRole = 'SHOP_OWNER',
  canManage: canManageProp = true,
  onSyncCameras,
  onSyncDvrConfig,
  onBackToHome,
}) => {
  const [subView, setSubView] = useState<CctvSubView>('dashboard');
  const [gridLayout, setGridLayout] = useState<GridLayoutMode>('2x2');
  const [gridPage, setGridPage] = useState(0);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('ALL');

  const [gatewayStatus, setGatewayStatus] = useState<CctvGatewayStatus>({
    ffmpegAvailable: true,
    ffprobeAvailable: true,
    activeStreamsCount: 0,
    cloudEnvironment: false,
  });
  const [recordings, setRecordings] = useState<CctvRecordingEntry[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [systemSettings, setSystemSettings] = useState<CctvSystemSettings>(DEFAULT_SETTINGS_CLIENT);
  const [storageSummary, setStorageSummary] = useState<CctvStorageSummary>({
    usedBytes: 0,
    availableBytes: null,
    totalDiskBytes: null,
    maxStorageMb: 2048,
    retentionDays: 30,
    autoDeleteExpired: false,
    warningThresholdPercent: 80,
    warningTriggered: false,
    usagePercent: 0,
    recordingsCount: 0,
    perCamera: [],
  });
  const [motionEvents, setMotionEvents] = useState<CctvMotionEvent[]>([]);
  const [effectiveCanManage, setEffectiveCanManage] = useState<boolean>(canManageProp);

  // PIN Security Gate inside CCTV module
  const [pinLocked, setPinLocked] = useState(false);
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinChecking, setPinChecking] = useState(false);

  // Modals & notifications
  const [isDvrModalOpen, setIsDvrModalOpen] = useState(false);
  const [isCameraModalOpen, setIsCameraModalOpen] = useState(false);
  const [editingCamera, setEditingCamera] = useState<CctvCamera | null>(null);
  const [camToDelete, setCamToDelete] = useState<CctvCamera | null>(null);
  const [recordingToDelete, setRecordingToDelete] = useState<CctvRecordingEntry | null>(null);
  const [storageCleanupModalOpen, setStorageCleanupModalOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState<number>(30);
  const [feedbackToast, setFeedbackToast] = useState<{ msg: string; tone: 'ok' | 'err' } | null>(null);

  // Live view controls state
  const liveContainerRef = useRef<HTMLDivElement | null>(null);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [detectedAudio, setDetectedAudio] = useState(false);
  const [refreshTickMap, setRefreshTickMap] = useState<Record<string, number>>({});
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [ptzStatusMsg, setPtzStatusMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Video Playback View state
  const [playbackFilterCam, setPlaybackFilterCam] = useState<string>('');
  const [playbackFilterDate, setPlaybackFilterDate] = useState<string>('');
  const [playbackFromTime, setPlaybackFromTime] = useState<string>('');
  const [playbackToTime, setPlaybackToTime] = useState<string>('');
  const [playbackList, setPlaybackList] = useState<CctvRecordingEntry[]>([]);
  const [activePlayback, setActivePlayback] = useState<{ entry: CctvRecordingEntry; url: string } | null>(null);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const playbackWrapperRef = useRef<HTMLDivElement | null>(null);
  const [pbPlaying, setPbPlaying] = useState(false);
  const [pbCurrentTime, setPbCurrentTime] = useState(0);
  const [pbDuration, setPbDuration] = useState(0);
  const [pbRate, setPbRate] = useState(1);

  // Camera Group creation
  const [newGroupName, setNewGroupName] = useState('');

  // Motion check target
  const [motionScanCameraId, setMotionScanCameraId] = useState<string>('');
  const [motionScanStatus, setMotionScanStatus] = useState<string | null>(null);

  // Settings PIN editor
  const [newPinInput, setNewPinInput] = useState('');

  // DVR Form State
  const [dvrBrand, setDvrBrand] = useState<DvrNvrConfig['brand']>(dvrConfig.brand || 'Hikvision');
  const [dvrIp, setDvrIp] = useState(dvrConfig.dvrIp || '192.168.1.100');
  const [dvrPort, setDvrPort] = useState(String(dvrConfig.port || 554));
  const [dvrUser, setDvrUser] = useState(dvrConfig.username || 'admin');
  const [dvrPass, setDvrPass] = useState('');
  const [showDvrPass, setShowDvrPass] = useState(false);
  const [channelCount, setChannelCount] = useState(dvrConfig.channelCount || 8);
  const [dvrSaving, setDvrSaving] = useState(false);
  const [dvrTestResult, setDvrTestResult] = useState<CctvConnectionTestResult | null>(null);

  // Add / Edit Camera Form State
  const [camName, setCamName] = useState('');
  const [camModel, setCamModel] = useState('');
  const [camLocation, setCamLocation] = useState('Cash Counter 01');
  const [camGroup, setCamGroup] = useState('Cash Counter 01');
  const [camType, setCamType] = useState<CctvCameraType>('rtsp');
  const [camIp, setCamIp] = useState('');
  const [camPort, setCamPort] = useState('554');
  const [camChannel, setCamChannel] = useState(1);
  const [camUsername, setCamUsername] = useState('');
  const [camPassword, setCamPassword] = useState('');
  const [showCamPassword, setShowCamPassword] = useState(false);
  const [camStreamUrl, setCamStreamUrl] = useState('');
  const [camResolution, setCamResolution] = useState('1080p FHD');
  const [camDescription, setCamDescription] = useState('');
  const [camRecordingMode, setCamRecordingMode] = useState<CctvRecordingMode>('manual');
  const [camSupportsPtz, setCamSupportsPtz] = useState(false);
  const [camSupportsAudio, setCamSupportsAudio] = useState(false);
  const [formTestLoading, setFormTestLoading] = useState(false);
  const [formTestResult, setFormTestResult] = useState<CctvConnectionTestResult | null>(null);
  const [formSaveLoading, setFormSaveLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const showToast = (msg: string, tone: 'ok' | 'err' = 'ok') => {
    setFeedbackToast({ msg, tone });
    window.setTimeout(() => setFeedbackToast(null), 4200);
  };

  const canManage = canManageProp && effectiveCanManage;

  const loadOverviewFromServer = async () => {
    try {
      const overview = await fetchCctvOverview(activeShopId);
      onSyncCameras(overview.cameras);
      if (overview.dvrConfig) onSyncDvrConfig(overview.dvrConfig);
      if (overview.gateway) setGatewayStatus(overview.gateway);
      setRecordings(overview.recordings || []);
      setPlaybackList(overview.recordings || []);
      if (overview.groups) setGroups(overview.groups);
      if (overview.settings) {
        setSystemSettings(overview.settings);
        setGridLayout(overview.settings.defaultGridLayout || '2x2');
        if (overview.settings.security?.pinEnabled) {
          setPinLocked(true);
        }
      }
      if (overview.storage) setStorageSummary(overview.storage);
      setMotionEvents(overview.motionEvents || []);
      if (overview.permissions) {
        setEffectiveCanManage(Boolean(overview.permissions.canManage));
      }
      if (!motionScanCameraId && overview.cameras.length > 0) {
        setMotionScanCameraId(overview.cameras[0].id);
      }
    } catch (err: any) {
      if (err?.status === 403) {
        showToast(err.message || 'You are not authorized to access CCTV cameras.', 'err');
      }
    }
  };

  useEffect(() => {
    loadOverviewFromServer();
  }, [activeShopId]);

  const activePlaybackUrlRef = useRef<string | null>(null);
  useEffect(() => {
    activePlaybackUrlRef.current = activePlayback?.url || null;
  }, [activePlayback?.url]);

  useEffect(() => {
    return () => {
      if (activePlaybackUrlRef.current) {
        URL.revokeObjectURL(activePlaybackUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    if (!motionScanCameraId && cameras.length > 0) {
      setMotionScanCameraId(cameras[0].id);
    }
  }, [cameras]);

  const locationGroups = useMemo(() => {
    const set = new Set<string>();
    groups.forEach((g) => {
      if (g?.trim()) set.add(g.trim());
    });
    cameras.forEach((c) => {
      if (c.group?.trim()) set.add(c.group.trim());
      if (c.location?.trim()) set.add(c.location.trim());
    });
    return ['ALL', ...Array.from(set)];
  }, [cameras, groups]);

  const filteredCameras = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return cameras.filter((cam) => {
      const camGrp = (cam.group || cam.location || '').trim();
      const groupMatch =
        selectedGroup === 'ALL' ||
        camGrp === selectedGroup ||
        (cam.location || '').trim() === selectedGroup;
      if (!groupMatch) return false;
      if (!q) return true;
      return (
        cam.name.toLowerCase().includes(q) ||
        (cam.model || '').toLowerCase().includes(q) ||
        (cam.location || '').toLowerCase().includes(q) ||
        camGrp.toLowerCase().includes(q) ||
        (cam.ipAddress || '').toLowerCase().includes(q) ||
        String(cam.channelNumber || '').includes(q) ||
        (cam.cameraType || '').toLowerCase().includes(q)
      );
    });
  }, [cameras, searchQuery, selectedGroup]);

  const onlineCount = useMemo(() => cameras.filter((c) => c.status === 'online').length, [cameras]);
  const offlineCount = cameras.length - onlineCount;
  const recordingNowCount = useMemo(() => cameras.filter((c) => c.isRecording).length, [cameras]);
  const selectedCamera = useMemo(
    () => cameras.find((c) => c.id === selectedCameraId) || cameras[0] || null,
    [cameras, selectedCameraId]
  );

  const activeCameraRecordings = useMemo(() => {
    if (!selectedCamera) return [];
    return recordings.filter((r) => r.cameraId === selectedCamera.id);
  }, [recordings, selectedCamera]);

  const pageSize = gridLayout === '1x1' ? 1 : gridLayout === '2x2' ? 4 : gridLayout === '3x3' ? 9 : 16;
  const totalGridPages = Math.max(1, Math.ceil(filteredCameras.length / pageSize));
  const safeGridPage = Math.min(gridPage, totalGridPages - 1);
  const pagedCameras = useMemo(() => {
    const start = safeGridPage * pageSize;
    return filteredCameras.slice(start, start + pageSize);
  }, [filteredCameras, safeGridPage, pageSize]);

  const handleUpdateSingleCameraInState = (updated: CctvCamera) => {
    onSyncCameras(cameras.map((c) => (c.id === updated.id ? updated : c)));
  };

  const openAddCameraModal = () => {
    setEditingCamera(null);
    setCamName(`Camera ${cameras.length + 1}`);
    setCamModel('');
    setCamLocation('Cash Counter 01');
    setCamGroup('Cash Counter 01');
    setCamType('rtsp');
    setCamIp('');
    setCamPort('554');
    setCamChannel(cameras.length + 1);
    setCamUsername('');
    setCamPassword('');
    setShowCamPassword(false);
    setCamStreamUrl('');
    setCamResolution('1080p FHD');
    setCamDescription('');
    setCamRecordingMode('manual');
    setCamSupportsPtz(false);
    setCamSupportsAudio(false);
    setFormTestResult(null);
    setFormError(null);
    setIsCameraModalOpen(true);
  };

  const openEditCameraModal = (cam: CctvCamera) => {
    setEditingCamera(cam);
    setCamName(cam.name);
    setCamModel(cam.model || '');
    setCamLocation(cam.location || 'Cash Counter 01');
    setCamGroup(cam.group || cam.location || 'Cash Counter 01');
    setCamType(cam.cameraType || 'rtsp');
    setCamIp(cam.ipAddress || '');
    setCamPort(String(cam.port || 554));
    setCamChannel(cam.channelNumber || 1);
    setCamUsername(cam.username || '');
    setCamPassword('');
    setShowCamPassword(false);
    setCamStreamUrl('');
    setCamResolution(cam.resolution || '1080p FHD');
    setCamDescription(cam.description || '');
    setCamRecordingMode(cam.recordingMode || 'manual');
    setCamSupportsPtz(Boolean(cam.supportsPtz));
    setCamSupportsAudio(Boolean(cam.supportsAudio));
    setFormTestResult(null);
    setFormError(null);
    setIsCameraModalOpen(true);
  };

  const handleCameraTypeChange = (nextType: CctvCameraType) => {
    setCamType(nextType);
    if (!editingCamera) {
      const opt = CAMERA_TYPE_OPTIONS.find((o) => o.value === nextType);
      if (opt) setCamPort(String(opt.defaultPort));
    }
  };

  const buildCameraPayload = (): CctvCameraInput => ({
    id: editingCamera?.id,
    name: camName.trim(),
    model: camModel.trim() || undefined,
    group: camGroup.trim() || camLocation.trim() || 'Main Shop',
    location: camLocation.trim() || 'Main Shop',
    cameraType: camType,
    ipAddress: camIp.trim(),
    port: camPort ? parseInt(camPort, 10) : undefined,
    channelNumber: Math.max(1, camChannel || 1),
    username: camUsername.trim(),
    password: camPassword || undefined,
    keepExistingPassword: editingCamera ? !camPassword : false,
    streamUrl: camStreamUrl.trim() || undefined,
    keepExistingStreamUrl: editingCamera ? !camStreamUrl.trim() : false,
    resolution: camResolution,
    description: camDescription.trim() || undefined,
    recordingMode: camRecordingMode,
    supportsPtz: camSupportsPtz,
    supportsAudio: camSupportsAudio,
  });

  const handleTestCameraInForm = async () => {
    setFormError(null);
    setFormTestResult(null);
    setFormTestLoading(true);
    try {
      const payload = buildCameraPayload();
      const result = await testCameraConnectionApi(
        { ...payload, cameraId: editingCamera?.id },
        activeShopId
      );
      setFormTestResult(result);
    } catch (err: any) {
      setFormError(err?.message || 'Connection test failed.');
    } finally {
      setFormTestLoading(false);
    }
  };

  const handleSaveCameraForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!camName.trim()) {
      setFormError('Camera name is required.');
      return;
    }

    setFormSaveLoading(true);
    try {
      const payload = buildCameraPayload();
      if (editingCamera) {
        const res = await updateCameraApi(
          editingCamera.id,
          { ...payload, testOnSave: true },
          activeShopId
        );
        handleUpdateSingleCameraInState(res.camera);
        setIsCameraModalOpen(false);
        showToast(
          res.camera.status === 'online'
            ? `${res.camera.name} updated and connected!`
            : `${res.camera.name} saved (Offline — ${res.camera.lastError || 'Check connection'})`,
          res.camera.status === 'online' ? 'ok' : 'err'
        );
      } else {
        const res = await createCameraApi({ ...payload, testOnSave: true }, activeShopId);
        onSyncCameras([...cameras, res.camera]);
        setIsCameraModalOpen(false);
        showToast(
          res.camera.status === 'online'
            ? `${res.camera.name} added & connected!`
            : `${res.camera.name} saved (Offline — ${res.camera.lastError || 'Check connection'})`,
          res.camera.status === 'online' ? 'ok' : 'err'
        );
      }
      await loadOverviewFromServer();
    } catch (err: any) {
      setFormError(err?.message || 'Could not save camera configuration.');
    } finally {
      setFormSaveLoading(false);
    }
  };

  const handleConfirmDeleteCamera = async () => {
    if (!camToDelete) return;
    setBusyAction(`delete:${camToDelete.id}`);
    try {
      await deleteCameraApi(camToDelete.id, activeShopId);
      const next = cameras.filter((c) => c.id !== camToDelete.id);
      onSyncCameras(next);
      if (selectedCameraId === camToDelete.id) {
        setSelectedCameraId(next[0]?.id || null);
      }
      showToast(`Deleted "${camToDelete.name}".`);
      setCamToDelete(null);
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete camera.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshSingleCamera = async (cam: CctvCamera) => {
    setBusyAction(`refresh:${cam.id}`);
    try {
      const res = await refreshCameraApi(cam.id, activeShopId);
      handleUpdateSingleCameraInState(res.camera);
      setRefreshTickMap((prev) => ({ ...prev, [cam.id]: (prev[cam.id] || 0) + 1 }));
      showToast(
        res.ok ? `${cam.name} is Online (${res.result.latencyMs ?? '-'}ms)` : `${cam.name}: ${res.result.message}`,
        res.ok ? 'ok' : 'err'
      );
    } catch (err: any) {
      showToast(err?.message || 'Refresh connection failed.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshAll = async () => {
    setIsRefreshingAll(true);
    try {
      const updated = await refreshAllCamerasApi(activeShopId);
      onSyncCameras(updated);
      const nextTicks: Record<string, number> = { ...refreshTickMap };
      updated.forEach((c) => {
        nextTicks[c.id] = (nextTicks[c.id] || 0) + 1;
      });
      setRefreshTickMap(nextTicks);
      const onlineNow = updated.filter((c) => c.status === 'online').length;
      showToast(
        `Refreshed ${updated.length} cameras: ${onlineNow} Online, ${updated.length - onlineNow} Offline.`,
        onlineNow > 0 ? 'ok' : 'err'
      );
    } catch (err: any) {
      showToast(err?.message || 'Failed to refresh cameras.', 'err');
    } finally {
      setIsRefreshingAll(false);
    }
  };

  const handleSaveDvr = async (e: React.FormEvent) => {
    e.preventDefault();
    setDvrSaving(true);
    setDvrTestResult(null);
    try {
      const res = await saveDvrConfigApi(
        {
          brand: dvrBrand,
          dvrIp: dvrIp.trim(),
          port: parseInt(dvrPort, 10) || 554,
          username: dvrUser.trim() || 'admin',
          password: dvrPass || undefined,
          channelCount: channelCount || 8,
        },
        activeShopId
      );
      onSyncDvrConfig(res.dvrConfig);
      setDvrTestResult(res.testResult);
      if (res.testResult.ok) {
        showToast(`DVR connected (${dvrIp})!`);
        setIsDvrModalOpen(false);
      } else {
        showToast(`DVR saved, but probe reported: ${res.testResult.message}`, 'err');
      }
    } catch (err: any) {
      showToast(err?.message || 'Could not save DVR setup.', 'err');
    } finally {
      setDvrSaving(false);
    }
  };

  const handleToggleFullscreen = async (targetEl?: HTMLElement | null) => {
    const el = targetEl || liveContainerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      showToast('Fullscreen mode is not allowed by this browser/frame.', 'err');
    }
  };

  const handleCaptureSnapshot = async (cam: CctvCamera) => {
    setBusyAction(`snap:${cam.id}`);
    try {
      const blob = await captureCameraSnapshotBlob(cam.id, activeShopId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${cam.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast(`Snapshot saved from ${cam.name}!`);
    } catch (err: any) {
      const v = activeVideoRef.current;
      if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              (blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${cam.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.jpg`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1500);
                showToast(`Snapshot captured from ${cam.name}!`);
              },
              'image/jpeg',
              0.92
            );
            return;
          }
        } catch {}
      }
      showToast(err?.message || 'Snapshot capture failed.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handlePtz = async (
    cam: CctvCamera,
    action: 'left' | 'right' | 'up' | 'down' | 'zoom_in' | 'zoom_out' | 'stop'
  ) => {
    setPtzStatusMsg(`Sending PTZ ${action}...`);
    try {
      const res = await sendCameraPtzApi(cam.id, action, activeShopId);
      setPtzStatusMsg(res.message);
    } catch (err: any) {
      setPtzStatusMsg(err?.message || 'PTZ command failed.');
      showToast(err?.message || 'PTZ control failed.', 'err');
    }
  };

  const handleToggleRecording = async (cam: CctvCamera) => {
    setBusyAction(`rec:${cam.id}`);
    try {
      if (cam.isRecording) {
        const stopped = await stopCameraRecordingApi(cam.id, undefined, activeShopId);
        handleUpdateSingleCameraInState({ ...cam, isRecording: false });
        const list = await listFilteredRecordingsApi({}, activeShopId);
        setRecordings(list);
        setPlaybackList(list);
        showToast(`Recording stopped (${stopped.durationSec || 0}s saved).`);
      } else {
        await startCameraRecordingApi(cam.id, activeShopId, 'manual');
        handleUpdateSingleCameraInState({ ...cam, isRecording: true });
        const list = await listFilteredRecordingsApi({}, activeShopId);
        setRecordings(list);
        showToast(`Recording started for ${cam.name}.`);
      }
    } catch (err: any) {
      showToast(err?.message || 'Recording operation failed.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenPlayback = async (entry: CctvRecordingEntry) => {
    setBusyAction(`play:${entry.id}`);
    try {
      if (activePlayback?.url) {
        URL.revokeObjectURL(activePlayback.url);
      }
      const blobUrl = await fetchAuthorizedRecordingBlobUrl(entry.id, activeShopId);
      setActivePlayback({ entry, url: blobUrl });
      setPbCurrentTime(0);
      setPbDuration(entry.durationSec || 0);
      setPbRate(1);
      setPbPlaying(true);
      setSubView('playback');
    } catch (err: any) {
      showToast(err?.message || 'Unable to load recording file.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadRecording = async (entry: CctvRecordingEntry) => {
    setBusyAction(`dl:${entry.id}`);
    try {
      const blobUrl = await fetchAuthorizedRecordingBlobUrl(entry.id, activeShopId);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${entry.cameraName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${entry.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      showToast(`Exported ${entry.cameraName} recording.`);
    } catch (err: any) {
      showToast(err?.message || 'Download failed.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteRecording = async () => {
    if (!recordingToDelete) return;
    try {
      await deleteCameraRecordingApi(recordingToDelete.id, activeShopId);
      setRecordings((prev) => prev.filter((r) => r.id !== recordingToDelete.id));
      setPlaybackList((prev) => prev.filter((r) => r.id !== recordingToDelete.id));
      if (activePlayback?.entry.id === recordingToDelete.id) {
        URL.revokeObjectURL(activePlayback.url);
        setActivePlayback(null);
      }
      showToast('Recording deleted.');
      setRecordingToDelete(null);
      await loadOverviewFromServer();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete recording.', 'err');
    }
  };

  const handleSearchPlayback = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusyAction('playback-filter');
    try {
      const list = await listFilteredRecordingsApi(
        {
          cameraId: playbackFilterCam || undefined,
          date: playbackFilterDate || undefined,
          fromTime: playbackFromTime || undefined,
          toTime: playbackToTime || undefined,
        },
        activeShopId
      );
      setPlaybackList(list);
    } catch (err: any) {
      showToast(err?.message || 'Failed to search recordings.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    try {
      const nextGroups = await createCctvGroupApi(newGroupName.trim(), activeShopId);
      setGroups(nextGroups);
      setNewGroupName('');
      showToast(`Added group "${newGroupName.trim()}".`);
    } catch (err: any) {
      showToast(err?.message || 'Could not add camera group.', 'err');
    }
  };

  const handleDeleteGroup = async (grp: string) => {
    try {
      const res = await deleteCctvGroupApi(grp, activeShopId);
      setGroups(res.groups);
      onSyncCameras(res.cameras);
      if (selectedGroup === grp) setSelectedGroup('ALL');
      showToast(`Removed group "${grp}".`);
    } catch (err: any) {
      showToast(err?.message || 'Could not delete group.', 'err');
    }
  };

  const handleSaveSettings = async (partial?: Partial<CctvSystemSettings> & { newPin?: string; clearPin?: boolean }) => {
    setBusyAction('save-settings');
    try {
      const payload = partial || systemSettings;
      const res = await saveCctvSettingsApi(payload, activeShopId);
      setSystemSettings(res.settings);
      if (res.storage) setStorageSummary(res.storage);
      setNewPinInput('');
      showToast('CCTV settings saved.');
    } catch (err: any) {
      showToast(err?.message || 'Could not save CCTV settings.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncSchedule = async () => {
    setBusyAction('sync-schedule');
    try {
      await saveCctvSettingsApi(systemSettings, activeShopId);
      const res = await syncRecordingSchedulesApi(activeShopId);
      onSyncCameras(res.cameras);
      const started = res.results.filter((r) => r.action === 'started').length;
      const offline = res.results.filter((r) => r.action === 'offline').length;
      showToast(
        started > 0
          ? `Schedule applied: ${started} camera recording(s) started.`
          : offline > 0
          ? `Schedule saved (${offline} offline camera(s) skipped).`
          : 'Recording schedule saved.',
        offline > 0 && started === 0 ? 'err' : 'ok'
      );
      await loadOverviewFromServer();
    } catch (err: any) {
      showToast(err?.message || 'Failed to sync recording schedule.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunMotionScan = async () => {
    const camId = motionScanCameraId || cameras[0]?.id;
    if (!camId) {
      showToast('Add a camera first to run motion analysis.', 'err');
      return;
    }
    setBusyAction('motion-scan');
    setMotionScanStatus(null);
    try {
      const res = await runCameraMotionCheckApi(camId, systemSettings.motionDetection.sensitivity, activeShopId);
      setMotionEvents(res.events);
      setMotionScanStatus(res.message);
      showToast(res.message, res.detected ? 'ok' : 'ok');
    } catch (err: any) {
      const msg = err?.message || 'Could not run motion scan on offline/unreachable camera.';
      setMotionScanStatus(msg);
      showToast(msg, 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmCleanup = async () => {
    setBusyAction('storage-cleanup');
    try {
      const res = await cleanupCctvStorageApi(
        { olderThanDays: cleanupDays, confirmDelete: true },
        activeShopId
      );
      setRecordings(res.recordings);
      setPlaybackList(res.recordings);
      setStorageSummary(res.storage);
      setStorageCleanupModalOpen(false);
      showToast(`Deleted ${res.deletedCount} old recording(s), freed ${formatBytes(res.freedBytes)}.`);
    } catch (err: any) {
      showToast(err?.message || 'Storage cleanup failed.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleExportBackup = async () => {
    setBusyAction('backup-export');
    try {
      const backup = await exportCctvBackupApi(activeShopId);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `waqas_pos_cctv_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('Sanitized CCTV configuration backup exported (passwords redacted).');
    } catch (err: any) {
      showToast(err?.message || 'Export failed.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleImportBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusyAction('backup-import');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await importCctvBackupApi(json, activeShopId);
      onSyncCameras(res.cameras);
      setGroups(res.groups);
      setSystemSettings(res.settings);
      showToast('CCTV settings and camera profiles restored.');
    } catch (err: any) {
      showToast(err?.message || 'Invalid CCTV backup JSON file.', 'err');
    } finally {
      setBusyAction(null);
    }
  };

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    setPinChecking(true);
    try {
      const ok = await verifyCctvPinApi(pinEntry, activeShopId);
      if (ok) {
        setPinLocked(false);
        setPinEntry('');
      } else {
        setPinError('Incorrect CCTV Security PIN.');
      }
    } catch (err: any) {
      setPinError(err?.message || 'Incorrect CCTV Security PIN.');
    } finally {
      setPinChecking(false);
    }
  };

  const seekPlayback = (deltaSec: number) => {
    const v = playbackVideoRef.current;
    if (!v) return;
    const next = Math.max(0, Math.min(v.duration || pbDuration || 0, v.currentTime + deltaSec));
    v.currentTime = next;
    setPbCurrentTime(next);
  };

  const gridClassName =
    gridLayout === '4x4'
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
      : gridLayout === '3x3'
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2';

  const activeCapabilities = selectedCamera?.capabilities;
  const showMuteButton = Boolean(selectedCamera && (selectedCamera.supportsAudio || detectedAudio || activeCapabilities?.audio));
  const showSnapshotButton = Boolean(selectedCamera && activeCapabilities?.snapshot !== false);
  const showPtzPanel = Boolean(selectedCamera && selectedCamera.supportsPtz && canManage);
  const showRecordingPanel = Boolean(
    selectedCamera &&
      gatewayStatus.ffmpegAvailable &&
      selectedCamera.cameraType !== 'webrtc' &&
      (canManage || activeCameraRecordings.length > 0)
  );

  const navTabs: Array<{ id: CctvSubView; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: 'Dashboard', icon: <Video className="w-3.5 h-3.5" /> },
    { id: 'live', label: 'Live View', icon: <Maximize2 className="w-3.5 h-3.5" /> },
    { id: 'cameras', label: 'Cameras & Groups', icon: <Camera className="w-3.5 h-3.5" /> },
    { id: 'recordings', label: 'Recordings', icon: <Film className="w-3.5 h-3.5" /> },
    { id: 'playback', label: 'Playback', icon: <Play className="w-3.5 h-3.5" /> },
    { id: 'motion', label: 'Motion & Alerts', icon: <Bell className="w-3.5 h-3.5" /> },
    { id: 'status', label: 'Device Status', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'storage', label: 'Storage', icon: <HardDrive className="w-3.5 h-3.5" /> },
    { id: 'settings', label: 'Settings', icon: <Sliders className="w-3.5 h-3.5" /> },
  ];

  if (pinLocked) {
    return (
      <div className="flex-1 min-h-full w-full bg-[#0b1329] text-white flex flex-col">
        <FullScreenPageHeader
          title="CCTV Security Monitor"
          subtitle="PIN Protected — Enter CCTV Security PIN to view live cameras & footage"
          icon={<Lock className="w-5 h-5 text-emerald-400" />}
          onBackToHome={onBackToHome}
          accentColor="emerald"
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <form
            onSubmit={handleUnlockPin}
            className="w-full max-w-sm bg-[#111c38] border border-slate-700 rounded-2xl p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-emerald-950/70 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-white">CCTV Lock Enabled</h2>
                <p className="text-xs text-slate-400">Enter 4–8 digit CCTV Security PIN</p>
              </div>
            </div>
            <input
              type="password"
              inputMode="numeric"
              value={pinEntry}
              onChange={(e) => setPinEntry(e.target.value)}
              placeholder="Enter CCTV PIN"
              autoFocus
              className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-[#1b284f] border border-slate-600 text-sm font-mono tracking-widest text-white outline-none focus:border-emerald-500"
            />
            {pinError && (
              <p className="text-xs text-red-400 font-semibold flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{pinError}</span>
              </p>
            )}
            <button
              type="submit"
              disabled={pinChecking || !pinEntry.trim()}
              className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer"
            >
              {pinChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
              <span>Unlock CCTV Monitor</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-full w-full bg-[#0b1329] text-white flex flex-col font-sans overflow-x-hidden">
      <FullScreenPageHeader
        title="CCTV Security & NVR Center"
        subtitle="دکان کیمرہ سسٹم — IP، RTSP، ONVIF اور DVR/NVR لائیو مانیٹر"
        icon={<Video className="w-5 h-5 text-emerald-400" />}
        onBackToHome={onBackToHome}
        accentColor="emerald"
        actions={
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Preserved Grid Switcher: 1 Cam, 4 Grid, 9 Grid, 16 Grid */}
            <div className="bg-[#1b284f] p-1 rounded-xl flex items-center gap-0.5 sm:gap-1 border border-slate-700">
              {(['1x1', '2x2', '3x3', '4x4'] as GridLayoutMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`cctv-grid-${mode}`}
                  onClick={() => {
                    setGridLayout(mode);
                    setGridPage(0);
                    if (mode === '1x1' && !selectedCameraId && filteredCameras.length > 0) {
                      setSelectedCameraId(filteredCameras[0].id);
                    }
                    if (subView !== 'dashboard' && subView !== 'live') {
                      setSubView('live');
                    }
                  }}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors cursor-pointer ${
                    gridLayout === mode
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {mode === '1x1' ? '1 Cam' : mode === '2x2' ? '4 Grid' : mode === '3x3' ? '9 Grid' : '16 Grid'}
                </button>
              ))}
            </div>

            <button
              type="button"
              data-testid="cctv-refresh-all-btn"
              onClick={handleRefreshAll}
              disabled={isRefreshingAll || cameras.length === 0}
              className="min-h-[36px] px-2.5 sm:px-3 py-1.5 bg-[#1b284f] hover:bg-[#25376c] disabled:opacity-50 text-white font-semibold text-xs rounded-xl flex items-center gap-1.5 border border-slate-700 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 ${isRefreshingAll ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            {canManage && (
              <>
                <button
                  type="button"
                  data-testid="cctv-dvr-setup-btn"
                  onClick={() => {
                    setDvrBrand(dvrConfig.brand || 'Hikvision');
                    setDvrIp(dvrConfig.dvrIp || '192.168.1.100');
                    setDvrPort(String(dvrConfig.port || 554));
                    setDvrUser(dvrConfig.username || 'admin');
                    setDvrPass('');
                    setChannelCount(dvrConfig.channelCount || 8);
                    setDvrTestResult(null);
                    setIsDvrModalOpen(true);
                  }}
                  className="min-h-[36px] px-2.5 sm:px-3 py-1.5 bg-[#1b284f] hover:bg-[#25376c] text-white font-semibold text-xs rounded-xl flex items-center gap-1.5 border border-slate-700 whitespace-nowrap cursor-pointer"
                >
                  <Server className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="hidden sm:inline">DVR / NVR</span>
                </button>

                <button
                  type="button"
                  data-testid="cctv-add-camera-btn"
                  onClick={openAddCameraModal}
                  className="min-h-[36px] px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Camera</span>
                </button>
              </>
            )}
          </div>
        }
      />

      {/* Unified Sub-Page Navigation Bar (9 sections inside single CCTV module) */}
      <div className="bg-[#111c38] border-b border-slate-800 px-3 sm:px-5 lg:px-6 py-2 flex items-center gap-2 overflow-x-auto">
        {subView !== 'dashboard' && (
          <button
            type="button"
            data-testid="cctv-back-dashboard-btn"
            onClick={() => setSubView('dashboard')}
            className="min-h-[40px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 text-emerald-400" />
            <span>CCTV Home</span>
          </button>
        )}
        <div className="flex items-center gap-1.5" data-testid="cctv-subnav">
          {navTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-testid={`cctv-tab-${tab.id}`}
              onClick={() => {
                setSubView(tab.id);
                if (tab.id === 'playback') {
                  handleSearchPlayback();
                }
              }}
              className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 border transition-colors cursor-pointer ${
                subView === tab.id
                  ? 'bg-emerald-600 text-white border-emerald-500'
                  : 'bg-[#1b284f]/70 text-slate-300 border-slate-700/70 hover:text-white hover:border-slate-500'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        {!canManage && (
          <span className="ml-auto text-[11px] font-semibold text-amber-300 whitespace-nowrap pl-2">
            View-Only Access ({userRole})
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col p-3 sm:p-5 lg:p-6 w-full space-y-4 overflow-y-auto">
        {feedbackToast && (
          <div
            className={`fixed top-16 right-4 z-50 px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 text-xs font-semibold border ${
              feedbackToast.tone === 'ok'
                ? 'bg-emerald-700 text-white border-emerald-400/40'
                : 'bg-red-800 text-white border-red-400/40'
            }`}
          >
            {feedbackToast.tone === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedbackToast.msg}</span>
          </div>
        )}

        {/* ==================== 1. DASHBOARD & 2. LIVE VIEW ==================== */}
        {(subView === 'dashboard' || subView === 'live') && (
          <>
            {subView === 'dashboard' && (
              <>
                {/* Summary KPI Row */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 sm:gap-3">
                  <button
                    type="button"
                    onClick={() => setSubView('cameras')}
                    className="bg-[#111c38] hover:border-slate-500 border border-slate-700/70 rounded-2xl p-3 flex items-center justify-between text-left cursor-pointer"
                  >
                    <div>
                      <p className="text-[11px] font-medium text-slate-400">All Cameras</p>
                      <p className="text-lg sm:text-xl font-bold tabular-nums text-white">{cameras.length}</p>
                    </div>
                    <Camera className="w-5 h-5 text-emerald-400 shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setSubView('live')}
                    className="bg-[#111c38] hover:border-slate-500 border border-slate-700/70 rounded-2xl p-3 flex items-center justify-between text-left cursor-pointer"
                  >
                    <div>
                      <p className="text-[11px] font-medium text-slate-400">Online</p>
                      <p className="text-lg sm:text-xl font-bold tabular-nums text-emerald-400">{onlineCount}</p>
                    </div>
                    <Wifi className="w-5 h-5 text-emerald-400 shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setSubView('status')}
                    className="bg-[#111c38] hover:border-slate-500 border border-slate-700/70 rounded-2xl p-3 flex items-center justify-between text-left cursor-pointer"
                  >
                    <div>
                      <p className="text-[11px] font-medium text-slate-400">Offline / Lost</p>
                      <p className={`text-lg sm:text-xl font-bold tabular-nums ${offlineCount > 0 ? 'text-amber-400' : 'text-slate-300'}`}>
                        {offlineCount}
                      </p>
                    </div>
                    <WifiOff className="w-5 h-5 text-amber-400 shrink-0" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setSubView('recordings')}
                    className="bg-[#111c38] hover:border-slate-500 border border-slate-700/70 rounded-2xl p-3 flex items-center justify-between text-left cursor-pointer"
                  >
                    <div>
                      <p className="text-[11px] font-medium text-slate-400">Recording Now</p>
                      <p className={`text-lg sm:text-xl font-bold tabular-nums ${recordingNowCount > 0 ? 'text-red-400' : 'text-slate-200'}`}>
                        {recordingNowCount}
                      </p>
                    </div>
                    <Circle className={`w-5 h-5 shrink-0 ${recordingNowCount > 0 ? 'text-red-500 fill-red-500' : 'text-slate-400'}`} />
                  </button>

                  <button
                    type="button"
                    onClick={() => setSubView('storage')}
                    className="col-span-2 md:col-span-1 bg-[#111c38] hover:border-slate-500 border border-slate-700/70 rounded-2xl p-3 flex items-center justify-between text-left cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-slate-400">Storage Used</p>
                      <p className="text-sm sm:text-base font-bold tabular-nums text-white truncate">
                        {formatBytes(storageSummary.usedBytes)}
                      </p>
                    </div>
                    <HardDrive className={`w-5 h-5 shrink-0 ${storageSummary.warningTriggered ? 'text-amber-400' : 'text-emerald-400'}`} />
                  </button>
                </div>

                {/* Quick Module Navigation Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                  {[
                    { id: 'live' as CctvSubView, title: 'Live Grid View', sub: '1, 4, 9 & 16 grids', icon: <Maximize2 className="w-4 h-4 text-emerald-400" /> },
                    { id: 'cameras' as CctvSubView, title: 'Cameras & Groups', sub: `${groups.length || locationGroups.length - 1} groups`, icon: <Camera className="w-4 h-4 text-sky-400" /> },
                    { id: 'recordings' as CctvSubView, title: 'Recordings', sub: `${recordings.length} clips`, icon: <Film className="w-4 h-4 text-purple-400" /> },
                    { id: 'playback' as CctvSubView, title: 'Video Playback', sub: 'Timeline & export', icon: <Play className="w-4 h-4 text-emerald-400" /> },
                    { id: 'motion' as CctvSubView, title: 'Motion & Alerts', sub: `${motionEvents.length} events`, icon: <Bell className="w-4 h-4 text-amber-400" /> },
                    { id: 'status' as CctvSubView, title: 'Device Status', sub: `Gateway ${gatewayStatus.ffmpegAvailable ? 'Ready' : 'External'}`, icon: <Activity className="w-4 h-4 text-cyan-400" /> },
                  ].map((tile) => (
                    <button
                      key={tile.id}
                      type="button"
                      onClick={() => {
                        setSubView(tile.id);
                        if (tile.id === 'playback') handleSearchPlayback();
                      }}
                      className="min-h-[54px] bg-[#111c38] hover:bg-[#17264a] border border-slate-700/70 rounded-xl p-2.5 flex items-center gap-2.5 text-left transition-colors cursor-pointer"
                    >
                      <div className="w-8 h-8 rounded-lg bg-[#1b284f] flex items-center justify-center shrink-0">
                        {tile.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-white truncate">{tile.title}</p>
                        <p className="text-[10px] text-slate-400 truncate">{tile.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Search + Group/Location Filter Bar */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  data-testid="cctv-search-input"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setGridPage(0);
                  }}
                  placeholder="Search cameras by name, model, location, group, IP or channel..."
                  className="w-full min-h-[42px] pl-9 pr-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-xs text-white placeholder-slate-400 outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                {locationGroups.map((grp) => (
                  <button
                    key={grp}
                    type="button"
                    onClick={() => {
                      setSelectedGroup(grp);
                      setGridPage(0);
                    }}
                    className={`min-h-[38px] px-3 py-1.5 rounded-xl text-[11px] font-semibold whitespace-nowrap border transition-colors cursor-pointer ${
                      selectedGroup === grp
                        ? 'bg-emerald-600 text-white border-emerald-500'
                        : 'bg-[#1b284f] text-slate-300 border-slate-700 hover:text-white'
                    }`}
                  >
                    {grp === 'ALL' ? `All Groups (${cameras.length})` : grp}
                  </button>
                ))}
              </div>
            </div>

            {/* Viewport: Empty State / Single View (1x1) / Multi Grid (4/9/16) */}
            {cameras.length === 0 ? (
              <div className="bg-[#111c38] rounded-2xl border border-slate-800 p-8 sm:p-12 text-center text-slate-400 space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-[#1b284f] text-emerald-400 flex items-center justify-center mx-auto">
                  <Camera className="w-7 h-7 stroke-[1.7]" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-white">No CCTV Cameras Configured</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Connect your shop IP cameras, RTSP streams, ONVIF cameras, HLS feeds, or DVR/NVR channels to view genuine live security video.
                  </p>
                </div>
                {canManage && (
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={openAddCameraModal}
                      className="min-h-[44px] px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl inline-flex items-center gap-2 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add First Camera</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsDvrModalOpen(true)}
                      className="min-h-[44px] px-4 py-2.5 bg-[#1b284f] hover:bg-[#25376c] text-white font-semibold text-xs rounded-xl inline-flex items-center gap-2 border border-slate-700 cursor-pointer"
                    >
                      <Server className="w-4 h-4 text-emerald-400" />
                      <span>Configure DVR / NVR</span>
                    </button>
                  </div>
                )}
              </div>
            ) : gridLayout === '1x1' && selectedCamera ? (
              /* Single Camera Large Live View + Controls */
              <div className="space-y-4">
                <div
                  ref={liveContainerRef}
                  className="bg-black rounded-2xl border border-slate-700 overflow-hidden relative"
                >
                  <div className="p-3 bg-[#111c38] flex flex-wrap items-center justify-between gap-2 border-b border-slate-800">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          selectedCamera.isRecording
                            ? 'bg-red-500 animate-pulse'
                            : selectedCamera.status === 'online'
                            ? 'bg-emerald-400'
                            : 'bg-red-500'
                        }`}
                      />
                      <span className="font-bold text-xs sm:text-sm text-white truncate">
                        CH-{selectedCamera.channelNumber} · {selectedCamera.name}
                      </span>
                      <span className="text-[11px] text-slate-400 hidden sm:inline truncate">
                        {selectedCamera.location}
                        {selectedCamera.model ? ` · ${selectedCamera.model}` : ''}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                          selectedCamera.isRecording
                            ? 'bg-red-950 text-red-300 border border-red-500/40'
                            : selectedCamera.status === 'online'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                            : 'bg-red-950 text-red-300 border border-red-500/40'
                        }`}
                      >
                        {selectedCamera.isRecording ? 'Recording' : selectedCamera.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleRefreshSingleCamera(selectedCamera)}
                        className="min-h-[36px] px-2.5 py-1.5 bg-[#1b284f] hover:bg-[#25376c] text-white rounded-lg text-xs font-semibold flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${busyAction === `refresh:${selectedCamera.id}` ? 'animate-spin' : ''}`} />
                        <span className="hidden sm:inline">Refresh</span>
                      </button>
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => openEditCameraModal(selectedCamera)}
                          className="min-h-[36px] px-2.5 py-1.5 bg-[#1b284f] hover:bg-[#25376c] text-white rounded-lg text-xs font-semibold flex items-center gap-1 whitespace-nowrap cursor-pointer"
                        >
                          <Edit2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="hidden sm:inline">Edit</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setGridLayout('2x2')}
                        className="min-h-[36px] px-2.5 py-1.5 bg-[#1b284f] hover:bg-[#25376c] text-white rounded-lg text-xs font-semibold flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        <Minimize2 className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">4 Grid</span>
                      </button>
                    </div>
                  </div>

                  <div className="aspect-video w-full bg-black">
                    <LiveCameraFeed
                      camera={selectedCamera}
                      shopId={activeShopId}
                      isActiveView={true}
                      muted={isMuted}
                      paused={isPaused}
                      refreshSignal={refreshTickMap[selectedCamera.id] || 0}
                      videoElRef={activeVideoRef}
                      onCameraUpdated={handleUpdateSingleCameraInState}
                      onAudioAvailabilityChange={setDetectedAudio}
                      onToast={showToast}
                    />
                  </div>

                  <div className="p-3 bg-[#111c38] border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setIsPaused((p) => !p)}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        {isPaused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
                        <span>{isPaused ? 'Resume' : 'Pause'}</span>
                      </button>

                      {showMuteButton && (
                        <button
                          type="button"
                          onClick={() => setIsMuted((m) => !m)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          {isMuted ? <VolumeX className="w-3.5 h-3.5 text-slate-400" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" />}
                          <span>{isMuted ? 'Unmute' : 'Mute'}</span>
                        </button>
                      )}

                      {showSnapshotButton && (
                        <button
                          type="button"
                          data-testid="cctv-snapshot-btn"
                          onClick={() => handleCaptureSnapshot(selectedCamera)}
                          disabled={busyAction === `snap:${selectedCamera.id}`}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <Camera className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Snapshot</span>
                        </button>
                      )}

                      {showRecordingPanel && canManage && (
                        <button
                          type="button"
                          data-testid="cctv-record-toggle-btn"
                          onClick={() => handleToggleRecording(selectedCamera)}
                          disabled={busyAction === `rec:${selectedCamera.id}`}
                          className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                            selectedCamera.isRecording
                              ? 'bg-red-600 hover:bg-red-700 text-white'
                              : 'bg-[#1b284f] hover:bg-[#25376c] text-white'
                          }`}
                        >
                          {selectedCamera.isRecording ? (
                            <>
                              <Square className="w-3.5 h-3.5 fill-current" />
                              <span>Stop Recording</span>
                            </>
                          ) : (
                            <>
                              <Circle className="w-3.5 h-3.5 text-red-400 fill-red-400" />
                              <span>Record Clip</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-400 font-mono tabular-nums hidden md:inline">
                        {selectedCamera.resolution} · {selectedCamera.cameraType.toUpperCase()}
                        {selectedCamera.latencyMs ? ` · ${selectedCamera.latencyMs}ms` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleToggleFullscreen()}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                        <span>{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Switch Camera + Optional PTZ & Quick Recordings */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-2.5">
                    <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">Switch Camera</h4>
                    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                      {filteredCameras.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setSelectedCameraId(c.id)}
                          className={`w-full min-h-[44px] px-3 py-2 rounded-xl text-left text-xs flex items-center justify-between border transition-colors cursor-pointer ${
                            c.id === selectedCamera.id
                              ? 'bg-emerald-950/60 border-emerald-500 text-white'
                              : 'bg-[#1b284f]/60 border-slate-700/60 text-slate-300 hover:border-slate-500'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="font-semibold truncate">CH-{c.channelNumber} · {c.name}</p>
                            <p className="text-[10px] text-slate-400 truncate">{c.group || c.location}</p>
                          </div>
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              c.status === 'online' ? 'bg-emerald-400' : 'bg-red-500'
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  {showPtzPanel && (
                    <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">ONVIF PTZ Controls</h4>
                        <span className="text-[10px] text-emerald-400 font-semibold">Pan · Tilt · Zoom</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 max-w-[180px] mx-auto">
                        <div />
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'up')}
                          className="min-h-[44px] p-2.5 rounded-xl bg-[#1b284f] hover:bg-emerald-600 flex items-center justify-center cursor-pointer"
                          aria-label="Tilt Up"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <div />
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'left')}
                          className="min-h-[44px] p-2.5 rounded-xl bg-[#1b284f] hover:bg-emerald-600 flex items-center justify-center cursor-pointer"
                          aria-label="Pan Left"
                        >
                          <ArrowLeft className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'stop')}
                          className="min-h-[44px] p-2.5 rounded-xl bg-slate-800 hover:bg-red-600 text-[10px] font-bold flex items-center justify-center cursor-pointer"
                        >
                          STOP
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'right')}
                          className="min-h-[44px] p-2.5 rounded-xl bg-[#1b284f] hover:bg-emerald-600 flex items-center justify-center cursor-pointer"
                          aria-label="Pan Right"
                        >
                          <ArrowRight className="w-4 h-4" />
                        </button>
                        <div />
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'down')}
                          className="min-h-[44px] p-2.5 rounded-xl bg-[#1b284f] hover:bg-emerald-600 flex items-center justify-center cursor-pointer"
                          aria-label="Tilt Down"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <div />
                      </div>
                      <div className="flex items-center justify-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'zoom_in')}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-emerald-600 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <ZoomIn className="w-3.5 h-3.5" />
                          <span>Zoom +</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePtz(selectedCamera, 'zoom_out')}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-emerald-600 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <ZoomOut className="w-3.5 h-3.5" />
                          <span>Zoom -</span>
                        </button>
                      </div>
                      {ptzStatusMsg && (
                        <p className="text-[11px] text-center text-slate-300">{ptzStatusMsg}</p>
                      )}
                    </div>
                  )}

                  {showRecordingPanel && (
                    <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                          <Film className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Saved Clips ({activeCameraRecordings.length})</span>
                        </h4>
                        <button
                          type="button"
                          onClick={() => setSubView('recordings')}
                          className="text-[11px] text-emerald-400 hover:underline font-semibold cursor-pointer"
                        >
                          View All
                        </button>
                      </div>
                      {activeCameraRecordings.length === 0 ? (
                        <p className="text-xs text-slate-400 py-4 text-center">
                          No recorded clips yet. Click &ldquo;Record Clip&rdquo; while live to save footage.
                        </p>
                      ) : (
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {activeCameraRecordings.map((rec) => (
                            <div
                              key={rec.id}
                              className="px-3 py-2 rounded-xl bg-[#1b284f]/70 border border-slate-700 flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-semibold text-white truncate tabular-nums">
                                  {new Date(rec.startedAt).toLocaleString()}
                                </p>
                                <p className="text-[10px] text-slate-400 font-mono tabular-nums">
                                  {rec.status === 'recording'
                                    ? 'Recording now...'
                                    : `${rec.durationSec || 1}s · ${formatBytes(rec.sizeBytes)}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {rec.status === 'ready' && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenPlayback(rec)}
                                    className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                                  >
                                    <Play className="w-3 h-3" />
                                    <span>Play</span>
                                  </button>
                                )}
                                {canManage && (
                                  <button
                                    type="button"
                                    onClick={() => setRecordingToDelete(rec)}
                                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-red-700 text-slate-300 hover:text-white cursor-pointer"
                                    title="Delete recording"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : filteredCameras.length === 0 ? (
              <div className="bg-[#111c38] border border-slate-800 rounded-2xl p-8 text-center text-slate-400 text-xs">
                No cameras match your current search or group filter.
              </div>
            ) : (
              /* Multi-Camera Grid (2x2 = 4, 3x3 = 9, 4x4 = 16) with pagination */
              <div className="space-y-3">
                <div className={`grid gap-3 ${gridClassName}`} data-testid="cctv-camera-grid">
                  {pagedCameras.map((cam) => (
                    <div
                      key={cam.id}
                      data-testid={`cctv-card-${cam.id}`}
                      onClick={() => {
                        setSelectedCameraId(cam.id);
                        setGridLayout('1x1');
                      }}
                      className="bg-black rounded-2xl border border-slate-800 overflow-hidden relative group cursor-pointer hover:border-emerald-500 transition-colors flex flex-col"
                    >
                      <div className="px-3 py-2 bg-[#111c38] border-b border-slate-800 flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              cam.isRecording
                                ? 'bg-red-500 animate-pulse'
                                : cam.status === 'online'
                                ? 'bg-emerald-400'
                                : cam.status === 'connecting'
                                ? 'bg-amber-400 animate-pulse'
                                : 'bg-red-500'
                            }`}
                          />
                          <span className="font-bold text-white truncate">
                            CH-{cam.channelNumber} · {cam.name}
                          </span>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                            cam.isRecording
                              ? 'bg-red-950 text-red-300 border border-red-500/40'
                              : cam.status === 'online'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                              : 'bg-red-950 text-red-300 border border-red-500/30'
                          }`}
                        >
                          {cam.isRecording ? 'Recording' : cam.status === 'online' ? 'Online' : 'Offline'}
                        </span>
                      </div>

                      <div className="aspect-video w-full bg-slate-950">
                        <LiveCameraFeed
                          camera={cam}
                          shopId={activeShopId}
                          isActiveView={false}
                          muted={true}
                          paused={false}
                          refreshSignal={refreshTickMap[cam.id] || 0}
                          onCameraUpdated={handleUpdateSingleCameraInState}
                          onToast={showToast}
                        />
                      </div>

                      <div
                        className="px-3 py-2 bg-[#111c38] border-t border-slate-800 flex items-center justify-between gap-2 text-[11px] text-slate-300"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-white truncate">
                            {cam.location}
                            {cam.model ? ` · ${cam.model}` : ''}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate font-mono tabular-nums">
                            {cam.cameraType.toUpperCase()} · {cam.ipAddress || 'Stream URL'} · {cam.resolution}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            data-testid={`cctv-refresh-${cam.id}`}
                            onClick={() => handleRefreshSingleCamera(cam)}
                            className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#1b284f] hover:bg-emerald-600 text-slate-200 hover:text-white flex items-center justify-center cursor-pointer"
                            title="Refresh Connection"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${busyAction === `refresh:${cam.id}` ? 'animate-spin' : ''}`} />
                          </button>
                          {canManage && (
                            <>
                              <button
                                type="button"
                                data-testid={`cctv-edit-${cam.id}`}
                                onClick={() => openEditCameraModal(cam)}
                                className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#1b284f] hover:bg-blue-600 text-slate-200 hover:text-white flex items-center justify-center cursor-pointer"
                                title="Edit Camera"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                data-testid={`cctv-delete-${cam.id}`}
                                onClick={() => setCamToDelete(cam)}
                                className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#1b284f] hover:bg-red-600 text-slate-200 hover:text-white flex items-center justify-center cursor-pointer"
                                title="Delete Camera"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCameraId(cam.id);
                              setGridLayout('1x1');
                            }}
                            className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center cursor-pointer"
                            title="Open Full View"
                          >
                            <Maximize2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {totalGridPages > 1 && (
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={safeGridPage === 0}
                      onClick={() => setGridPage((p) => Math.max(0, p - 1))}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#111c38] border border-slate-700 disabled:opacity-40 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      <span>Prev</span>
                    </button>
                    <span className="text-xs font-mono tabular-nums text-slate-300">
                      Page {safeGridPage + 1} / {totalGridPages}
                    </span>
                    <button
                      type="button"
                      disabled={safeGridPage >= totalGridPages - 1}
                      onClick={() => setGridPage((p) => Math.min(totalGridPages - 1, p + 1))}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#111c38] border border-slate-700 disabled:opacity-40 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <span>Next</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ==================== 3. CAMERAS & GROUP MANAGEMENT ==================== */}
        {subView === 'cameras' && (
          <div className="space-y-4">
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white">Camera Groups & Locations</h3>
                  <p className="text-xs text-slate-400">Organize shop cameras into custom areas like Cash Counter, Entrance, Stock Room, or Warehouse.</p>
                </div>
                {canManage && (
                  <form onSubmit={handleAddGroup} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="New group name..."
                      className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-xs text-white outline-none focus:border-emerald-500"
                    />
                    <button
                      type="submit"
                      className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      <span>Create Group</span>
                    </button>
                  </form>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {locationGroups.filter((g) => g !== 'ALL').map((grp) => (
                  <div
                    key={grp}
                    className="px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-xs flex items-center gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedGroup(grp);
                        setSubView('dashboard');
                      }}
                      className="font-semibold text-white hover:text-emerald-400 cursor-pointer"
                    >
                      {grp}
                    </button>
                    {canManage && !['Main Shop', 'Cash Counter 01', 'Main Entrance', 'Warehouse'].includes(grp) && (
                      <button
                        type="button"
                        onClick={() => handleDeleteGroup(grp)}
                        className="text-slate-400 hover:text-red-400 cursor-pointer"
                        title="Remove group"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-white">Registered Cameras ({cameras.length})</h3>
                {canManage && (
                  <button
                    type="button"
                    onClick={openAddCameraModal}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Camera</span>
                  </button>
                )}
              </div>
              {cameras.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No cameras registered yet. Click &ldquo;Add Camera&rdquo; to configure your first device.
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {cameras.map((cam) => (
                    <div key={cam.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-white">CH-{cam.channelNumber} · {cam.name}</span>
                          {cam.model && <span className="text-xs text-slate-300">({cam.model})</span>}
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${cam.status === 'online' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40' : 'bg-red-950 text-red-300 border border-red-500/40'}`}>
                            {cam.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 font-mono tabular-nums">
                          {cam.group || cam.location} · {cam.ipAddress || 'Stream URL'}:{cam.port || 554} · {cam.cameraType.toUpperCase()} · Mode: {cam.recordingMode || 'manual'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRefreshSingleCamera(cam)}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                        >
                          <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Test</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCameraId(cam.id);
                            setGridLayout('1x1');
                            setSubView('live');
                          }}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                        >
                          <Video className="w-3.5 h-3.5 text-sky-400" />
                          <span>Live</span>
                        </button>
                        {canManage && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEditCameraModal(cam)}
                              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-blue-600 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setCamToDelete(cam)}
                              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-red-600 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== 4. RECORDING MANAGEMENT ==================== */}
        {subView === 'recordings' && (
          <div className="space-y-4">
            {/* Schedule & Recording Mode Panel */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-emerald-400" />
                    <span>Recording Mode & Schedule</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Configure continuous, scheduled, motion-based, or manual recording via the FFmpeg server gateway.
                  </p>
                </div>
                {canManage && (
                  <button
                    type="button"
                    onClick={handleSyncSchedule}
                    disabled={busyAction === 'sync-schedule'}
                    className="min-h-[42px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    {busyAction === 'sync-schedule' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    <span>Save & Apply Schedule</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1.5">Default Recording Mode</label>
                  <select
                    disabled={!canManage}
                    value={systemSettings.defaultRecordingMode}
                    onChange={(e) =>
                      setSystemSettings((prev) => ({
                        ...prev,
                        defaultRecordingMode: e.target.value as CctvRecordingMode,
                      }))
                    }
                    className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white outline-none"
                  >
                    <option value="manual">Manual Recording</option>
                    <option value="continuous">Continuous (24/7 while online)</option>
                    <option value="scheduled">Scheduled Hours</option>
                    <option value="motion">Motion Triggered</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1.5">Schedule Window (Start – End)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      disabled={!canManage}
                      value={systemSettings.schedule.startTime}
                      onChange={(e) =>
                        setSystemSettings((prev) => ({
                          ...prev,
                          schedule: { ...prev.schedule, enabled: true, startTime: e.target.value },
                        }))
                      }
                      className="flex-1 min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                    />
                    <span className="text-slate-400">to</span>
                    <input
                      type="time"
                      disabled={!canManage}
                      value={systemSettings.schedule.endTime}
                      onChange={(e) =>
                        setSystemSettings((prev) => ({
                          ...prev,
                          schedule: { ...prev.schedule, enabled: true, endTime: e.target.value },
                        }))
                      }
                      className="flex-1 min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1.5">Schedule Days</label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => {
                      const active = systemSettings.schedule.days.includes(d.idx);
                      return (
                        <button
                          key={d.idx}
                          type="button"
                          disabled={!canManage}
                          onClick={() =>
                            setSystemSettings((prev) => {
                              const exists = prev.schedule.days.includes(d.idx);
                              const nextDays = exists
                                ? prev.schedule.days.filter((x) => x !== d.idx)
                                : [...prev.schedule.days, d.idx].sort();
                              return {
                                ...prev,
                                schedule: { ...prev.schedule, enabled: true, days: nextDays },
                              };
                            })
                          }
                          className={`min-h-[36px] px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer ${
                            active
                              ? 'bg-emerald-600 text-white border-emerald-500'
                              : 'bg-[#1b284f] text-slate-400 border-slate-700'
                          }`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Active Camera Recording Controls */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-3">
              <h3 className="text-sm font-bold text-white">Camera Recording Controls</h3>
              {cameras.length === 0 ? (
                <p className="text-xs text-slate-400">No cameras available to record.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                  {cameras.map((cam) => (
                    <div
                      key={cam.id}
                      className="p-3 rounded-xl bg-[#1b284f]/60 border border-slate-700 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-white truncate">{cam.name}</p>
                        <p className="text-[10px] text-slate-400 font-mono">
                          {cam.isRecording ? 'Recording active' : `Status: ${cam.status} · Mode: ${cam.recordingMode || 'manual'}`}
                        </p>
                      </div>
                      {canManage && cam.cameraType !== 'webrtc' && gatewayStatus.ffmpegAvailable && (
                        <button
                          type="button"
                          onClick={() => handleToggleRecording(cam)}
                          disabled={busyAction === `rec:${cam.id}`}
                          className={`min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                            cam.isRecording
                              ? 'bg-red-600 hover:bg-red-700 text-white'
                              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          }`}
                        >
                          {cam.isRecording ? <Square className="w-3 h-3 fill-current" /> : <Circle className="w-3 h-3 fill-current" />}
                          <span>{cam.isRecording ? 'Stop' : 'Start'}</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recording History List */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">Recording History ({recordings.length})</h3>
                <button
                  type="button"
                  onClick={() => loadOverviewFromServer()}
                  className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Refresh</span>
                </button>
              </div>
              {recordings.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No recorded video files exist yet. Start a manual or scheduled recording on a live connected camera.
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {recordings.map((rec) => (
                    <div key={rec.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-bold text-white truncate">
                          {rec.cameraName} · <span className="font-mono font-normal text-slate-300">{new Date(rec.startedAt).toLocaleString()}</span>
                        </p>
                        <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                          {rec.status === 'recording' ? 'Recording in progress' : `${rec.durationSec || 1}s · ${formatBytes(rec.sizeBytes)}`}
                          {rec.trigger ? ` · ${rec.trigger}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {rec.status === 'ready' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleOpenPlayback(rec)}
                              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center gap-1.5 cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                              <span>Play</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDownloadRecording(rec)}
                              className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-slate-200 font-semibold flex items-center gap-1.5 cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Download</span>
                            </button>
                          </>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setRecordingToDelete(rec)}
                            className="min-h-[38px] p-2 rounded-xl bg-[#1b284f] hover:bg-red-600 text-slate-300 hover:text-white cursor-pointer"
                            title="Delete recording"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== 5. VIDEO PLAYBACK ==================== */}
        {subView === 'playback' && (
          <div className="space-y-4">
            <form
              onSubmit={handleSearchPlayback}
              className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs items-end"
            >
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Camera</label>
                <select
                  value={playbackFilterCam}
                  onChange={(e) => setPlaybackFilterCam(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white outline-none"
                >
                  <option value="">All Cameras</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Date</label>
                <input
                  type="date"
                  value={playbackFilterDate}
                  onChange={(e) => setPlaybackFilterDate(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-300 mb-1">From Time</label>
                <input
                  type="time"
                  value={playbackFromTime}
                  onChange={(e) => setPlaybackFromTime(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-300 mb-1">To Time</label>
                <input
                  type="time"
                  value={playbackToTime}
                  onChange={(e) => setPlaybackToTime(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                />
              </div>
              <button
                type="submit"
                className="min-h-[42px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Search className="w-3.5 h-3.5" />
                <span>Search Footage</span>
              </button>
            </form>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Interactive Playback Player */}
              <div
                ref={playbackWrapperRef}
                className="lg:col-span-2 bg-black rounded-2xl border border-slate-700 overflow-hidden flex flex-col"
              >
                <div className="px-4 py-2.5 bg-[#111c38] border-b border-slate-800 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <p className="font-bold text-white truncate">
                      {activePlayback ? `${activePlayback.entry.cameraName} — Recorded Playback` : 'Select a Recorded Clip to Play'}
                    </p>
                    {activePlayback && (
                      <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                        {new Date(activePlayback.entry.startedAt).toLocaleString()} · {formatBytes(activePlayback.entry.sizeBytes)}
                      </p>
                    )}
                  </div>
                  {activePlayback && (
                    <button
                      type="button"
                      onClick={() => handleDownloadRecording(activePlayback.entry)}
                      className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] text-white font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Export MP4</span>
                    </button>
                  )}
                </div>

                <div className="aspect-video w-full bg-black flex items-center justify-center">
                  {activePlayback ? (
                    <video
                      ref={playbackVideoRef}
                      src={activePlayback.url}
                      autoPlay
                      playsInline
                      onTimeUpdate={(e) => setPbCurrentTime(e.currentTarget.currentTime)}
                      onLoadedMetadata={(e) => {
                        setPbDuration(e.currentTarget.duration || activePlayback.entry.durationSec || 0);
                        e.currentTarget.playbackRate = pbRate;
                      }}
                      onPlay={() => setPbPlaying(true)}
                      onPause={() => setPbPlaying(false)}
                      onEnded={() => setPbPlaying(false)}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="text-center p-6 text-slate-400 text-xs space-y-2">
                      <Film className="w-10 h-10 text-slate-600 mx-auto" />
                      <p>Choose a recorded clip from the list on the right to review footage with timeline controls.</p>
                    </div>
                  )}
                </div>

                {/* Timeline Scrubber + Transport Controls */}
                <div className="p-3 bg-[#111c38] border-t border-slate-800 space-y-2.5">
                  <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-300">
                    <span>{formatTimecode(pbCurrentTime)}</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, pbDuration || 1)}
                      step={0.25}
                      disabled={!activePlayback}
                      value={pbCurrentTime}
                      onChange={(e) => {
                        const t = parseFloat(e.target.value);
                        if (playbackVideoRef.current) playbackVideoRef.current.currentTime = t;
                        setPbCurrentTime(t);
                      }}
                      className="flex-1 accent-emerald-500 cursor-pointer"
                      aria-label="Timeline Scrubber"
                    />
                    <span>{formatTimecode(pbDuration)}</span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!activePlayback}
                        onClick={() => seekPlayback(-10)}
                        className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] disabled:opacity-40 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <Rewind className="w-3.5 h-3.5" />
                        <span>-10s</span>
                      </button>

                      <button
                        type="button"
                        disabled={!activePlayback}
                        onClick={() => {
                          const v = playbackVideoRef.current;
                          if (!v) return;
                          if (v.paused) v.play().catch(() => {});
                          else v.pause();
                        }}
                        className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                      >
                        {pbPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        <span>{pbPlaying ? 'Pause' : 'Play'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={!activePlayback}
                        onClick={() => {
                          const v = playbackVideoRef.current;
                          if (!v) return;
                          v.pause();
                          v.currentTime = 0;
                          setPbCurrentTime(0);
                          setPbPlaying(false);
                        }}
                        className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[#1b284f] hover:bg-red-700 disabled:opacity-40 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <Square className="w-3 h-3 fill-current" />
                        <span>Stop</span>
                      </button>

                      <button
                        type="button"
                        disabled={!activePlayback}
                        onClick={() => seekPlayback(10)}
                        className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] disabled:opacity-40 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <span>+10s</span>
                        <FastForward className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {[0.5, 1, 2].map((r) => (
                        <button
                          key={r}
                          type="button"
                          disabled={!activePlayback}
                          onClick={() => {
                            setPbRate(r);
                            if (playbackVideoRef.current) playbackVideoRef.current.playbackRate = r;
                          }}
                          className={`min-h-[36px] px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold cursor-pointer ${
                            pbRate === r
                              ? 'bg-emerald-600 text-white'
                              : 'bg-[#1b284f] text-slate-300 hover:text-white'
                          }`}
                        >
                          {r}x
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={!activePlayback}
                        onClick={() => handleToggleFullscreen(playbackWrapperRef.current)}
                        className="min-h-[36px] px-3 py-1 rounded-lg bg-[#1b284f] hover:bg-[#25376c] disabled:opacity-40 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                        <span>Fullscreen</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Matching Clips Sidebar */}
              <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-3 flex flex-col">
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Matching Footage ({playbackList.length})
                </h4>
                {playbackList.length === 0 ? (
                  <p className="text-xs text-slate-400 py-8 text-center">
                    No recordings match the selected camera/date/time filter.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {playbackList.map((rec) => (
                      <button
                        key={rec.id}
                        type="button"
                        disabled={rec.status !== 'ready'}
                        onClick={() => handleOpenPlayback(rec)}
                        className={`w-full p-3 rounded-xl border text-left text-xs transition-colors cursor-pointer ${
                          activePlayback?.entry.id === rec.id
                            ? 'bg-emerald-950/60 border-emerald-500 text-white'
                            : 'bg-[#1b284f]/60 border-slate-700 text-slate-200 hover:border-slate-500'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold truncate">{rec.cameraName}</span>
                          <span className="text-[10px] font-mono text-emerald-400">{rec.durationSec || 1}s</span>
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                          {new Date(rec.startedAt).toLocaleString()} · {formatBytes(rec.sizeBytes)}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ==================== 6. MOTION DETECTION & ALERTS ==================== */}
        {subView === 'motion' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-4 text-xs">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Bell className="w-4 h-4 text-amber-400" />
                  <span>Motion Detection Settings</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Analyzes real camera stream frames via FFmpeg scene-delta inspection. No simulated events are ever generated.
                </p>
              </div>

              <label className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-[#1b284f]/60 border border-slate-700 cursor-pointer">
                <span className="font-semibold text-slate-200">Enable Motion Detection</span>
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={systemSettings.motionDetection.enabled}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      motionDetection: { ...prev.motionDetection, enabled: e.target.checked },
                    }))
                  }
                  className="accent-emerald-500 w-4 h-4"
                />
              </label>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-300">Detection Sensitivity</span>
                  <span className="font-mono font-bold text-emerald-400">{systemSettings.motionDetection.sensitivity}%</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  disabled={!canManage}
                  value={systemSettings.motionDetection.sensitivity}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      motionDetection: { ...prev.motionDetection, sensitivity: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-emerald-500"
                />
              </div>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-slate-200">Auto-Record on Real Motion Trigger</span>
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={systemSettings.motionDetection.recordOnMotion}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      motionDetection: { ...prev.motionDetection, recordOnMotion: e.target.checked },
                    }))
                  }
                  className="accent-emerald-500 w-4 h-4"
                />
              </label>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-slate-200">In-App Motion Alert Notification</span>
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={systemSettings.motionDetection.notifyInApp}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      motionDetection: { ...prev.motionDetection, notifyInApp: e.target.checked },
                    }))
                  }
                  className="accent-emerald-500 w-4 h-4"
                />
              </label>

              {canManage && (
                <button
                  type="button"
                  onClick={() => handleSaveSettings()}
                  className="w-full min-h-[42px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer"
                >
                  Save Motion Settings
                </button>
              )}

              <div className="pt-3 border-t border-slate-800 space-y-2">
                <label className="block font-semibold text-slate-300">Run Live Frame Scan</label>
                <select
                  value={motionScanCameraId}
                  onChange={(e) => setMotionScanCameraId(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-white"
                >
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                  ))}
                </select>
                {canManage && (
                  <button
                    type="button"
                    onClick={handleRunMotionScan}
                    disabled={busyAction === 'motion-scan' || cameras.length === 0}
                    className="w-full min-h-[42px] rounded-xl bg-[#1b284f] hover:bg-[#25376c] border border-slate-600 text-white font-semibold flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {busyAction === 'motion-scan' ? <Loader2 className="w-4 h-4 animate-spin text-emerald-400" /> : <Activity className="w-4 h-4 text-emerald-400" />}
                    <span>Run Real Frame Check</span>
                  </button>
                )}
                {motionScanStatus && (
                  <p className="text-[11px] text-slate-300 bg-[#1b284f]/50 p-2.5 rounded-xl border border-slate-700">
                    {motionScanStatus}
                  </p>
                )}
              </div>
            </div>

            <div className="lg:col-span-2 bg-[#111c38] border border-slate-700/70 rounded-2xl overflow-hidden flex flex-col">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">Real Motion Event History ({motionEvents.length})</h3>
                {canManage && motionEvents.length > 0 && (
                  <button
                    type="button"
                    onClick={async () => {
                      await clearMotionEventsApi(activeShopId);
                      setMotionEvents([]);
                      showToast('Motion event log cleared.');
                    }}
                    className="min-h-[36px] px-3 py-1 rounded-xl bg-[#1b284f] hover:bg-red-700 text-xs font-semibold cursor-pointer"
                  >
                    Clear Log
                  </button>
                )}
              </div>

              {motionEvents.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-400 space-y-2">
                  <Bell className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="font-semibold text-slate-200">No Real Motion Events Recorded</p>
                  <p className="max-w-md mx-auto">
                    Genuine motion alerts appear here when a connected camera stream triggers a frame-change scan or ONVIF motion notification.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {motionEvents.map((ev) => {
                    const linkedRec = ev.recordingId ? recordings.find((r) => r.id === ev.recordingId) : undefined;
                    return (
                      <div key={ev.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0 space-y-0.5">
                          <p className="font-bold text-white truncate">
                            {ev.cameraName} · <span className="font-mono font-normal text-amber-300">Score {ev.confidenceScore}%</span>
                          </p>
                          <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                            {new Date(ev.timestamp).toLocaleString()} · {ev.source}
                          </p>
                          {ev.notes && <p className="text-[11px] text-slate-300 truncate">{ev.notes}</p>}
                        </div>
                        {linkedRec && linkedRec.status === 'ready' && (
                          <button
                            type="button"
                            onClick={() => handleOpenPlayback(linkedRec)}
                            className="min-h-[36px] px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center gap-1.5 shrink-0 cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>View Clip</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== 7. DEVICE & CONNECTION STATUS ==================== */}
        {subView === 'status' && (
          <div className="space-y-4">
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-emerald-400" />
                  <span>Gateway & DVR Diagnostics</span>
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  FFmpeg: {gatewayStatus.ffmpegAvailable ? 'Ready' : 'Not Installed'} · DVR: {dvrConfig.brand} ({dvrConfig.dvrIp}:{dvrConfig.port}) · {dvrConfig.connected ? 'Reachable' : 'Offline/Standby'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleRefreshAll}
                disabled={isRefreshingAll || cameras.length === 0}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingAll ? 'animate-spin' : ''}`} />
                <span>Test All Connections</span>
              </button>
            </div>

            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-slate-800">
                <h3 className="text-sm font-bold text-white">Camera Connection & Diagnostic Health ({cameras.length})</h3>
              </div>
              {cameras.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">No cameras added yet.</div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {cameras.map((cam) => (
                    <div key={cam.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-white text-sm">{cam.name}</span>
                          {cam.model && <span className="text-slate-300 font-mono">{cam.model}</span>}
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${cam.status === 'online' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40' : 'bg-red-950 text-red-300 border border-red-500/40'}`}>
                            {cam.status}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                          IP: {cam.ipAddress || 'Stream URL'}:{cam.port || 554} · Type: {cam.cameraType.toUpperCase()} · Quality: {cam.resolution}{cam.codec ? ` (${cam.codec})` : ''} · Latency: {cam.latencyMs !== undefined ? `${cam.latencyMs}ms` : 'N/A'}
                        </p>
                        <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                          Last Checked: {cam.lastCheckedAt ? new Date(cam.lastCheckedAt).toLocaleString() : 'Never'} · Last Connected: {cam.lastConnectedAt ? new Date(cam.lastConnectedAt).toLocaleString() : 'Not yet connected'}
                        </p>
                        {cam.lastError && cam.status !== 'online' && (
                          <p className="text-[11px] text-red-300 bg-red-950/40 border border-red-500/30 rounded-lg px-2.5 py-1.5 mt-1">
                            {getFriendlyErrorLabel(cam.errorCode)}: {cam.lastError}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRefreshSingleCamera(cam)}
                        disabled={busyAction === `refresh:${cam.id}`}
                        className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#1b284f] hover:bg-emerald-600 text-white font-semibold flex items-center gap-1.5 self-start md:self-center shrink-0 cursor-pointer"
                      >
                        <RotateCcw className={`w-3.5 h-3.5 ${busyAction === `refresh:${cam.id}` ? 'animate-spin' : ''}`} />
                        <span>Reconnect</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Troubleshooting Instructions */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-2 text-xs">
              <h4 className="font-bold text-white flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <span>Camera & DVR Connection Troubleshooting Guide</span>
              </h4>
              <ul className="list-disc pl-5 space-y-1 text-slate-300">
                <li><strong>Power & LAN Cable</strong>: Confirm the camera or DVR/NVR is powered on and connected to the shop router.</li>
                <li><strong>Credentials</strong>: Double-check camera/DVR username and password (HTTP 401/403 indicates invalid credentials).</li>
                <li><strong>RTSP / HTTP Ports</strong>: Standard RTSP uses port <code className="font-mono text-emerald-300">554</code>, ONVIF/HTTP uses <code className="font-mono text-emerald-300">80</code>.</li>
                <li><strong>Cloud vs Local Shop Gateway</strong>: Private LAN IPs (<code className="font-mono">192.168.x.x</code> / <code className="font-mono">10.x.x.x</code>) are only reachable from the local shop gateway, VPN, DDNS, or forwarded router port.</li>
              </ul>
            </div>
          </div>
        )}

        {/* ==================== 8. STORAGE MANAGEMENT ==================== */}
        {subView === 'storage' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
            <div className="lg:col-span-2 bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    <span>Real Recording Storage Metrics</span>
                  </h3>
                  <p className="text-[11px] text-slate-400">Measured directly from shop recording files and host disk space.</p>
                </div>
                <span className="font-mono font-bold text-sm tabular-nums text-emerald-400">
                  {storageSummary.usagePercent}% of {storageSummary.maxStorageMb} MB quota
                </span>
              </div>

              {storageSummary.warningTriggered && (
                <div className="p-3 rounded-xl bg-amber-950/60 border border-amber-500/40 text-amber-200 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    Storage usage ({storageSummary.usagePercent}%) exceeded your {storageSummary.warningThresholdPercent}% warning threshold. Export important footage or clean up old clips.
                  </span>
                </div>
              )}

              <div className="w-full h-3 bg-[#1b284f] rounded-full overflow-hidden border border-slate-700">
                <div
                  className={`h-full transition-all ${storageSummary.warningTriggered ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.min(100, Math.max(2, storageSummary.usagePercent))}%` }}
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-[#1b284f]/60 border border-slate-700">
                  <p className="text-[11px] text-slate-400">Used by CCTV</p>
                  <p className="text-base font-bold font-mono tabular-nums text-white">{formatBytes(storageSummary.usedBytes)}</p>
                </div>
                <div className="p-3 rounded-xl bg-[#1b284f]/60 border border-slate-700">
                  <p className="text-[11px] text-slate-400">Available Disk</p>
                  <p className="text-base font-bold font-mono tabular-nums text-emerald-400">
                    {storageSummary.availableBytes !== null ? formatBytes(storageSummary.availableBytes) : 'N/A'}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-[#1b284f]/60 border border-slate-700">
                  <p className="text-[11px] text-slate-400">Total Host Disk</p>
                  <p className="text-base font-bold font-mono tabular-nums text-slate-200">
                    {storageSummary.totalDiskBytes !== null ? formatBytes(storageSummary.totalDiskBytes) : 'N/A'}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-[#1b284f]/60 border border-slate-700">
                  <p className="text-[11px] text-slate-400">Saved Clips</p>
                  <p className="text-base font-bold font-mono tabular-nums text-white">{storageSummary.recordingsCount}</p>
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <h4 className="font-bold text-slate-200">Per-Camera Storage Usage</h4>
                {storageSummary.perCamera.length === 0 ? (
                  <p className="text-slate-400">No camera recordings currently occupy disk space.</p>
                ) : (
                  <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden">
                    {storageSummary.perCamera.map((item) => (
                      <div key={item.cameraId} className="px-3.5 py-2.5 flex items-center justify-between">
                        <span className="font-semibold text-white">{item.cameraName}</span>
                        <span className="font-mono tabular-nums text-slate-300">
                          {item.recordingsCount} clip(s) · {formatBytes(item.usedBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-4">
              <h3 className="text-sm font-bold text-white">Retention & Cleanup Rules</h3>
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Retention Days (1–365)</label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  disabled={!canManage}
                  value={systemSettings.storage.retentionDays}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      storage: { ...prev.storage, retentionDays: Math.max(1, Number(e.target.value) || 30) },
                    }))
                  }
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Max Storage Limit (MB)</label>
                <input
                  type="number"
                  min={100}
                  max={500000}
                  disabled={!canManage}
                  value={systemSettings.storage.maxStorageMb}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      storage: { ...prev.storage, maxStorageMb: Math.max(100, Number(e.target.value) || 2048) },
                    }))
                  }
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                />
              </div>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-slate-200">Opt-in Auto-Delete Expired</span>
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={systemSettings.storage.autoDeleteExpired}
                  onChange={(e) =>
                    setSystemSettings((prev) => ({
                      ...prev,
                      storage: { ...prev.storage, autoDeleteExpired: e.target.checked },
                    }))
                  }
                  className="accent-emerald-500 w-4 h-4"
                />
              </label>

              {canManage && (
                <button
                  type="button"
                  onClick={() => handleSaveSettings()}
                  className="w-full min-h-[42px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer"
                >
                  Save Retention Settings
                </button>
              )}

              {canManage && (
                <div className="pt-3 border-t border-slate-800 space-y-2">
                  <label className="block font-semibold text-slate-300">Manual Old Recording Cleanup</label>
                  <select
                    value={cleanupDays}
                    onChange={(e) => setCleanupDays(Number(e.target.value))}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-white"
                  >
                    <option value={0}>Delete all finished recordings</option>
                    <option value={7}>Older than 7 days</option>
                    <option value={30}>Older than 30 days</option>
                    <option value={90}>Older than 90 days</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setStorageCleanupModalOpen(true)}
                    className="w-full min-h-[42px] rounded-xl bg-red-600/90 hover:bg-red-700 text-white font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Delete Old Recordings...</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== 9. CCTV SETTINGS & SECURITY ==================== */}
        {subView === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
            {/* Display & Camera Defaults */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-emerald-400" />
                <span>Display Layout & System Settings</span>
              </h3>
              <div>
                <label className="block font-semibold text-slate-300 mb-1.5">Default Live Grid Layout</label>
                <select
                  disabled={!canManage}
                  value={systemSettings.defaultGridLayout}
                  onChange={(e) => {
                    const nextGrid = e.target.value as GridLayoutMode;
                    setSystemSettings((prev) => ({ ...prev, defaultGridLayout: nextGrid }));
                    setGridLayout(nextGrid);
                  }}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#1b284f] border border-slate-700 text-white"
                >
                  <option value="1x1">Single Camera (1x1)</option>
                  <option value="2x2">4 Cameras (2x2 Grid)</option>
                  <option value="3x3">9 Cameras (3x3 Grid)</option>
                  <option value="4x4">16 Cameras (4x4 Grid)</option>
                </select>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => handleSaveSettings()}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer"
                >
                  Save Display & Recording Settings
                </button>
              )}

              <div className="pt-3 border-t border-slate-800 space-y-3">
                <h4 className="font-bold text-white">CCTV Backup & Restore</h4>
                <p className="text-[11px] text-slate-400">
                  Exports camera profiles, groups, and schedules with passwords & PIN hashes automatically redacted.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={handleExportBackup}
                        className="min-h-[42px] px-4 py-2 rounded-xl bg-[#1b284f] hover:bg-[#25376c] border border-slate-600 text-white font-semibold flex items-center gap-1.5 cursor-pointer"
                      >
                        <Download className="w-4 h-4 text-emerald-400" />
                        <span>Export CCTV JSON</span>
                      </button>
                      <label className="min-h-[42px] px-4 py-2 rounded-xl bg-[#1b284f] hover:bg-[#25376c] border border-slate-600 text-white font-semibold flex items-center gap-1.5 cursor-pointer">
                        <Upload className="w-4 h-4 text-sky-400" />
                        <span>Restore CCTV JSON</span>
                        <input type="file" accept="application/json,.json" onChange={handleImportBackupFile} className="hidden" />
                      </label>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Access Control & CCTV PIN Security */}
            <div className="bg-[#111c38] border border-slate-700/70 rounded-2xl p-4 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>User Access & CCTV Security Lock</span>
              </h3>

              <div className="p-3 rounded-xl bg-[#1b284f]/50 border border-slate-700 space-y-1.5">
                <p className="font-bold text-white">Role Access Policy</p>
                <p className="text-slate-300">· <strong>Super Admin / Shop Owner</strong>: Full Camera, DVR, PTZ, Storage & Settings control.</p>
                <p className="text-slate-300">· <strong>Staff / Operator</strong>: Controlled per-staff in Staff Management (<code className="font-mono">View CCTV</code> / <code className="font-mono">Manage CCTV</code>).</p>
                <p className="text-emerald-300 text-[11px]">· Camera passwords & raw stream URLs remain AES-256-GCM encrypted on the server only.</p>
              </div>

              <label className="flex items-center justify-between gap-2 p-3 rounded-xl bg-[#1b284f]/60 border border-slate-700 cursor-pointer">
                <div>
                  <p className="font-bold text-white">Enforce Staff View-Only Mode</p>
                  <p className="text-[11px] text-slate-400">Prevent staff accounts from adding/editing/deleting cameras or storage.</p>
                </div>
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={systemSettings.security.staffViewOnly}
                  onChange={(e) => {
                    const next = {
                      ...systemSettings,
                      security: { ...systemSettings.security, staffViewOnly: e.target.checked },
                    };
                    setSystemSettings(next);
                    handleSaveSettings(next);
                  }}
                  className="accent-emerald-500 w-4 h-4 shrink-0"
                />
              </label>

              {canManage && (
                <div className="pt-2 border-t border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white">Optional CCTV PIN Protection</span>
                    <span className={`font-mono font-bold ${systemSettings.security.pinEnabled ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {systemSettings.security.pinEnabled ? 'PIN Active' : 'Disabled'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="password"
                      inputMode="numeric"
                      value={newPinInput}
                      onChange={(e) => setNewPinInput(e.target.value)}
                      placeholder="New 4–8 digit PIN"
                      className="flex-1 min-w-[140px] min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] border border-slate-700 text-white font-mono"
                    />
                    <button
                      type="button"
                      disabled={!/^\d{4,8}$/.test(newPinInput.trim())}
                      onClick={() => handleSaveSettings({ ...systemSettings, newPin: newPinInput.trim() })}
                      className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold cursor-pointer"
                    >
                      Set PIN
                    </button>
                    {systemSettings.security.pinEnabled && (
                      <>
                        <button
                          type="button"
                          onClick={() => setPinLocked(true)}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#1b284f] hover:bg-[#25376c] border border-slate-600 text-white font-semibold cursor-pointer"
                        >
                          Lock Now
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveSettings({ ...systemSettings, clearPin: true })}
                          className="min-h-[40px] px-3 py-1.5 rounded-xl bg-red-600/80 hover:bg-red-700 text-white font-semibold cursor-pointer"
                        >
                          Remove PIN
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit Camera Modal */}
      {isCameraModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="bg-[#111c38] text-white rounded-3xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-700 mb-4">
              <div className="flex items-center gap-2">
                <Camera className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm sm:text-base">
                  {editingCamera ? `Edit Camera: ${editingCamera.name}` : 'Add CCTV Camera'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCameraModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveCameraForm} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Camera Name *</label>
                  <input
                    type="text"
                    required
                    data-testid="cctv-form-name"
                    value={camName}
                    onChange={(e) => setCamName(e.target.value)}
                    placeholder="e.g. Cash Counter 1"
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-300 mb-1">Camera Model</label>
                  <input
                    type="text"
                    data-testid="cctv-form-model"
                    value={camModel}
                    onChange={(e) => setCamModel(e.target.value)}
                    placeholder="e.g. Hikvision DS-2CD1023"
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Location *</label>
                  <input
                    type="text"
                    required
                    list="cctv-location-presets"
                    data-testid="cctv-form-location"
                    value={camLocation}
                    onChange={(e) => setCamLocation(e.target.value)}
                    placeholder="Cash Counter / Entrance"
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                  <datalist id="cctv-location-presets">
                    {LOCATION_PRESETS.map((loc) => (
                      <option key={loc} value={loc} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="block font-bold text-slate-300 mb-1">Camera Group</label>
                  <input
                    type="text"
                    list="cctv-group-presets"
                    data-testid="cctv-form-group"
                    value={camGroup}
                    onChange={(e) => setCamGroup(e.target.value)}
                    placeholder="e.g. Cash Counter 01"
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                  <datalist id="cctv-group-presets">
                    {locationGroups.filter((g) => g !== 'ALL').map((grp) => (
                      <option key={grp} value={grp} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block font-bold text-slate-300 mb-1">Camera Type *</label>
                  <select
                    data-testid="cctv-form-type"
                    value={camType}
                    onChange={(e) => handleCameraTypeChange(e.target.value as CctvCameraType)}
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  >
                    {CAMERA_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-300 mb-1">Channel #</label>
                  <input
                    type="number"
                    min="1"
                    max="64"
                    data-testid="cctv-form-channel"
                    value={camChannel}
                    onChange={(e) => setCamChannel(parseInt(e.target.value, 10) || 1)}
                    className="w-full min-h-[40px] font-bold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block font-bold text-slate-300 mb-1">Camera IP Address / Host</label>
                  <input
                    type="text"
                    data-testid="cctv-form-ip"
                    value={camIp}
                    onChange={(e) => setCamIp(e.target.value)}
                    placeholder="192.168.1.100 or camera.ddns.net"
                    className="w-full min-h-[40px] font-mono font-bold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Port</label>
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    data-testid="cctv-form-port"
                    value={camPort}
                    onChange={(e) => setCamPort(e.target.value)}
                    placeholder="554"
                    className="w-full min-h-[40px] font-mono font-bold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Username</label>
                  <input
                    type="text"
                    data-testid="cctv-form-username"
                    value={camUsername}
                    onChange={(e) => setCamUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="off"
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-300 mb-1">
                    Password {editingCamera?.hasPassword ? '(Saved — optional)' : ''}
                  </label>
                  <div className="relative">
                    <input
                      type={showCamPassword ? 'text' : 'password'}
                      data-testid="cctv-form-password"
                      value={camPassword}
                      onChange={(e) => setCamPassword(e.target.value)}
                      placeholder={editingCamera?.hasPassword ? 'Leave blank to keep saved' : 'Camera password'}
                      autoComplete="new-password"
                      className="w-full min-h-[40px] font-semibold pl-3 pr-9 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCamPassword((s) => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                    >
                      {showCamPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-300 mb-1">
                  Stream URL (RTSP / HLS .m3u8 / MJPEG / WebRTC WHEP)
                </label>
                <input
                  type="text"
                  data-testid="cctv-form-stream-url"
                  value={camStreamUrl}
                  onChange={(e) => setCamStreamUrl(e.target.value)}
                  placeholder={
                    editingCamera?.streamUrlMasked
                      ? `Saved: ${editingCamera.streamUrlMasked} (enter new URL to replace)`
                      : 'rtsp://192.168.1.100:554/Streaming/Channels/101'
                  }
                  className="w-full min-h-[40px] font-mono text-[11px] px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Credentials are encrypted on the server and never exposed in browser URLs or logs.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Recording Mode</label>
                  <select
                    value={camRecordingMode}
                    onChange={(e) => setCamRecordingMode(e.target.value as CctvRecordingMode)}
                    className="w-full min-h-[40px] px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                  >
                    <option value="manual">Manual</option>
                    <option value="continuous">Continuous</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="motion">Motion-Based</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Description (Optional)</label>
                  <input
                    type="text"
                    data-testid="cctv-form-description"
                    value={camDescription}
                    onChange={(e) => setCamDescription(e.target.value)}
                    placeholder="Covers main register"
                    className="w-full min-h-[40px] px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-1">
                <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200 font-semibold">
                  <input
                    type="checkbox"
                    checked={camSupportsPtz}
                    onChange={(e) => setCamSupportsPtz(e.target.checked)}
                    className="rounded border-slate-600 accent-emerald-500"
                  />
                  <span>Supports ONVIF PTZ Controls</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200 font-semibold">
                  <input
                    type="checkbox"
                    checked={camSupportsAudio}
                    onChange={(e) => setCamSupportsAudio(e.target.checked)}
                    className="rounded border-slate-600 accent-emerald-500"
                  />
                  <span>Camera Audio Enabled</span>
                </label>
              </div>

              {formError && (
                <div className="p-3 rounded-xl bg-red-950/70 border border-red-500/40 text-red-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </div>
              )}

              {formTestResult && (
                <div
                  data-testid="cctv-test-result"
                  className={`p-3 rounded-xl border flex items-start gap-2 ${
                    formTestResult.ok
                      ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
                      : 'bg-red-950/60 border-red-500/40 text-red-200'
                  }`}
                >
                  {formTestResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <div className="space-y-0.5">
                    <p className="font-bold">
                      {formTestResult.ok ? 'Connection Verified' : getFriendlyErrorLabel(formTestResult.errorCode)}
                    </p>
                    <p className="text-[11px]">{formTestResult.message}</p>
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-700/70 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  data-testid="cctv-form-test-btn"
                  onClick={handleTestCameraInForm}
                  disabled={formTestLoading}
                  className="min-h-[42px] px-4 py-2 font-bold bg-[#1b284f] hover:bg-[#25376c] border border-slate-600 text-white rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  {formTestLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                  ) : (
                    <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                  <span>Test Connection</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsCameraModalOpen(false)}
                    className="min-h-[42px] px-4 py-2 font-bold text-slate-400 hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    data-testid="cctv-form-save-btn"
                    disabled={formSaveLoading}
                    className="min-h-[42px] px-5 py-2 font-bold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-xl flex items-center gap-1.5 cursor-pointer"
                  >
                    {formSaveLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>{editingCamera ? 'Save Changes' : 'Save Camera'}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DVR / NVR Master Setup Modal */}
      {isDvrModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-[#111c38] text-white rounded-3xl w-full max-w-sm p-5 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-700 mb-4">
              <div className="flex items-center gap-2">
                <Server className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm">DVR / NVR Master Setup</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsDvrModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDvr} className="space-y-3 text-xs">
              <div>
                <label className="block font-bold text-slate-300 mb-1">DVR / NVR Brand</label>
                <select
                  value={dvrBrand}
                  onChange={(e) => setDvrBrand(e.target.value as DvrNvrConfig['brand'])}
                  className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                >
                  <option value="Hikvision">Hikvision</option>
                  <option value="Dahua">Dahua</option>
                  <option value="Uniview">Uniview</option>
                  <option value="CP PLUS">CP PLUS</option>
                  <option value="Generic ONVIF">Generic ONVIF / RTSP</option>
                  <option value="Custom RTSP/IP">Custom RTSP / IP</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-300 mb-1">DVR IP Address / DDNS Host *</label>
                <input
                  type="text"
                  required
                  value={dvrIp}
                  onChange={(e) => setDvrIp(e.target.value)}
                  placeholder="192.168.1.100"
                  className="w-full min-h-[40px] font-mono font-bold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">RTSP Port</label>
                  <input
                    type="number"
                    value={dvrPort}
                    onChange={(e) => setDvrPort(e.target.value)}
                    className="w-full min-h-[40px] font-mono font-bold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-300 mb-1">Channels</label>
                  <select
                    value={channelCount}
                    onChange={(e) => setChannelCount(parseInt(e.target.value, 10))}
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                  >
                    <option value={4}>4 Channel</option>
                    <option value={8}>8 Channel</option>
                    <option value={16}>16 Channel</option>
                    <option value={32}>32 Channel</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-300 mb-1">DVR Username</label>
                  <input
                    type="text"
                    value={dvrUser}
                    onChange={(e) => setDvrUser(e.target.value)}
                    className="w-full min-h-[40px] font-semibold px-3 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-300 mb-1">DVR Password</label>
                  <div className="relative">
                    <input
                      type={showDvrPass ? 'text' : 'password'}
                      value={dvrPass}
                      onChange={(e) => setDvrPass(e.target.value)}
                      placeholder={dvrConfig.hasPassword ? 'Keep saved' : 'Password'}
                      className="w-full min-h-[40px] font-semibold pl-3 pr-8 py-2 rounded-xl border border-slate-700 bg-[#1b284f] text-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowDvrPass((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                    >
                      {showDvrPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              {dvrTestResult && (
                <div
                  className={`p-2.5 rounded-xl border text-[11px] ${
                    dvrTestResult.ok
                      ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
                      : 'bg-red-950/60 border-red-500/40 text-red-200'
                  }`}
                >
                  {dvrTestResult.message}
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsDvrModalOpen(false)}
                  className="min-h-[40px] px-4 py-2 font-bold text-slate-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={dvrSaving}
                  className="min-h-[40px] px-5 py-2 font-bold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  {dvrSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Save & Test DVR</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Delete Camera Modal */}
      {camToDelete && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-[#111c38] text-white rounded-3xl w-full max-w-sm p-5 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-950/70 border border-red-500/40 flex items-center justify-center text-red-400 shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm">Delete Camera?</h3>
                <p className="text-xs text-slate-400">
                  Remove <strong>{camToDelete.name}</strong> ({camToDelete.location}) from your CCTV monitor?
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCamToDelete(null)}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-[#1b284f] text-slate-300 hover:text-white text-xs font-bold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="cctv-confirm-delete-btn"
                onClick={handleConfirmDeleteCamera}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold cursor-pointer"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Recording Modal */}
      {recordingToDelete && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-[#111c38] text-white rounded-3xl w-full max-w-sm p-5 shadow-2xl border border-slate-700 space-y-4">
            <h3 className="font-bold text-sm">Delete Recording Clip?</h3>
            <p className="text-xs text-slate-400">
              This will permanently remove the saved video clip from {recordingToDelete.cameraName}.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRecordingToDelete(null)}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-[#1b284f] text-slate-300 text-xs font-bold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteRecording}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold cursor-pointer"
              >
                Delete Recording
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Explicit Confirmation Modal for Old Recording Storage Cleanup */}
      {storageCleanupModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-[#111c38] text-white rounded-3xl w-full max-w-sm p-5 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-950/70 border border-red-500/40 flex items-center justify-center text-red-400 shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-sm">Confirm Old Recordings Deletion</h3>
                <p className="text-xs text-slate-400">
                  {cleanupDays === 0
                    ? 'Permanently delete ALL finished CCTV recordings for this shop?'
                    : `Permanently delete recordings older than ${cleanupDays} days?`}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setStorageCleanupModalOpen(false)}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-[#1b284f] text-slate-300 text-xs font-bold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmCleanup}
                disabled={busyAction === 'storage-cleanup'}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold cursor-pointer"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
