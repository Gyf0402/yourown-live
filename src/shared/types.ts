export type PlatformId = 'huya' | 'douyu' | 'bilibili' | 'douyin';

export type ChannelPlatform = PlatformId | 'web';

export type WebUserAgentMode = 'desktop' | 'mobile';

export type LayoutMode = '1x1' | '1x2' | '2x1' | '1+2' | '2x2';

export type PaneViewMode = 'pure' | 'full';

export type DanmakuArea = 'third' | 'half' | 'full';

export type DanmakuMode = 'scroll' | 'chat';

export type ThemeMode = 'light' | 'dark' | 'system';

export type VideoFitMode = 'contain' | 'cover';

export type ChannelSortMode = 'live' | 'custom';

export interface SplitRatios {
  col: number; // 20..80 percentage
  row: number; // 20..80 percentage
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface DanmakuStatusEvent {
  slotIndex: number;
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
  platform?: PlatformId;
  message?: string;
}

export interface DiagnosticLogEntry {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: 'stream' | 'danmaku' | 'window' | 'auth' | 'system';
  message: string;
}

export interface Channel {
  id: string;
  platform: ChannelPlatform;
  roomId: string;
  name: string;
  group: string;
  url: string;
  pinned?: boolean;
  remarkLocked?: boolean;
  groupLocked?: boolean;
  createdAt: number;
}

export interface PaneSlot {
  slotIndex: number;
  channelId: string | null;
  url: string | null;
  platform: ChannelPlatform | null;
  title: string;
  muted: boolean;
  mode: PaneViewMode;
  volume?: number;
  fitMode?: VideoFitMode;
  preferredQualityId?: string;
  preferredLineId?: string;
  danmakuEnabled?: boolean;
  webZoom?: number | 'auto';
  webUserAgentMode?: WebUserAgentMode;
}

export interface AppSettings {
  layout: LayoutMode;
  sidebarCollapsed: boolean;
  alwaysOnTop: boolean;
  globalMuted: boolean;
  soloSlotIndex: number | null;
  autoHighestQuality: boolean;
  hideGiftEffects: boolean;
  danmakuEnabled: boolean;
  danmakuArea?: DanmakuArea;
  danmakuOpacity?: number;
  danmakuFontSize?: number;
  danmakuSpeed?: number;
  danmakuMode?: DanmakuMode;
  danmakuBlockKeywords?: string[];
  theme?: ThemeMode;
  channelSortMode?: ChannelSortMode;
  customGroups?: string[];
  hiddenDefaultGroups?: string[];
  ignoredUpdateVersion?: string;
  splitRatios?: SplitRatios;
  windowBounds?: WindowBounds;
  bossKeyShortcut: string;
  panes: PaneSlot[];
}

export interface PersistedState {
  channels: Channel[];
  settings: AppSettings;
}

export interface WebviewPurifyConfig {
  mode: PaneViewMode;
  autoHighestQuality: boolean;
  hideGiftEffects: boolean;
  danmakuEnabled: boolean;
}

export interface StreamOptionItem {
  id: string;
  label: string;
  active: boolean;
  locked?: boolean;
}

export interface StreamOptionsInfo {
  qualities: StreamOptionItem[];
  lines: StreamOptionItem[];
}

export interface CodecProbeResult {
  h264: boolean;
  hevc: boolean;
  av1: boolean;
  mseH264: boolean;
  mseHevc: boolean;
  userAgent: string;
}

export interface PlatformAuthInfo {
  loggedIn: boolean;
  accountHint?: string;
}

export type AuthStatusMap = Record<PlatformId, PlatformAuthInfo>;

export interface ResolvedLiveInput {
  ok: boolean;
  platform?: ChannelPlatform;
  roomId?: string;
  url?: string;
  suggestedName?: string;
  suggestedCategory?: string;
  needsPlatform?: boolean;
  reason?: string;
}

export interface DirectStreamRequest {
  platform: PlatformId;
  roomId: string;
  qualityId?: string;
  lineId?: string;
  autoHighestQuality?: boolean;
}

export interface DirectStreamResult {
  ok: boolean;
  platform: PlatformId;
  roomId: string;
  status: 'live' | 'offline' | 'error';
  title?: string;
  anchorName?: string;
  category?: string;
  flvUrl?: string;
  hlsUrl?: string;
  referer: string;
  qualities: StreamOptionItem[];
  lines: StreamOptionItem[];
  error?: string;
}

export interface DanmakuMessage {
  id: string;
  slotIndex: number;
  platform: PlatformId;
  user: string;
  text: string;
  color?: string;
  ts: number;
}

export type LiveStatusState = 'live' | 'replay' | 'offline' | 'unknown';

export interface LiveStatusCheckItem {
  id: string;
  platform: PlatformId;
  roomId: string;
}

export interface LiveRoomStatus {
  status: LiveStatusState;
  title?: string;
  anchorName?: string;
  category?: string;
  checkedAt: number;
}

export interface UpdateAssetInfo {
  name: string;
  url: string;
  size: number;
}

export interface AppUpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  hasUpdate: boolean;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  releaseUrl: string;
  installerAsset?: UpdateAssetInfo;
  portableAsset?: UpdateAssetInfo;
  isPortableInstall?: boolean;
  error?: string;
}

export interface UpdateDownloadProgress {
  phase: 'idle' | 'downloading' | 'completed' | 'cancelled' | 'error';
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  fileName?: string;
  filePath?: string;
  error?: string;
}

export interface LiveHubAPI {
  loadState: () => Promise<PersistedState>;
  saveState: (state: PersistedState) => Promise<void>;
  setAlwaysOnTop: (flag: boolean) => Promise<boolean>;
  setWindowFullScreen: (flag: boolean) => Promise<boolean>;
  toggleBossHide: () => Promise<boolean>;
  setBossKeyShortcut: (shortcut: string) => Promise<{ ok: boolean; error?: string }>;
  openPlatformLogin: (platform: PlatformId) => Promise<void>;
  getAuthStatus: () => Promise<AuthStatusMap>;
  clearPlatformCookies: (platform?: PlatformId) => Promise<AuthStatusMap>;
  getWebviewPreloadPath: () => Promise<string>;
  wakeWebview: (webContentsId: number, width?: number, height?: number) => Promise<void>;
  registerFreeWebContents: (webContentsId: number) => Promise<void>;
  resolveLiveInput: (rawInput: string, fallbackPlatform?: ChannelPlatform) => Promise<ResolvedLiveInput>;
  resolveStream: (req: DirectStreamRequest) => Promise<DirectStreamResult>;
  checkLiveStatuses: (
    items: LiveStatusCheckItem[]
  ) => Promise<Record<string, LiveRoomStatus>>;
  startDanmaku: (
    slotIndex: number,
    platform: PlatformId,
    roomId: string,
    forceReconnect?: boolean
  ) => Promise<{ ok: boolean; error?: string }>;
  stopDanmaku: (slotIndex: number) => Promise<void>;
  setWindowTheme: (isDark: boolean) => Promise<void>;
  copyScreenshot: (dataUrl: string) => Promise<boolean>;
  getDiagnostics: () => Promise<DiagnosticLogEntry[]>;
  clearDiagnostics: () => Promise<void>;
  getAppInfo: () => Promise<{ version: string; electron: string; chrome: string; userDataPath: string }>;
  checkForUpdates: () => Promise<AppUpdateCheckResult>;
  downloadUpdate: (
    url: string,
    fileName: string
  ) => Promise<{ ok: boolean; filePath?: string; cancelled?: boolean; error?: string }>;
  cancelUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  openExternalUrl: (url: string) => Promise<boolean>;
  onBossKeyTriggered: (callback: (hidden: boolean) => void) => () => void;
  onAuthStatusChanged: (
    callback: (payload: { status: AuthStatusMap; changedPlatform?: PlatformId }) => void
  ) => () => void;
  onDanmakuBatch: (callback: (batch: DanmakuMessage[]) => void) => () => void;
  onDanmakuStatus: (callback: (ev: DanmakuStatusEvent) => void) => () => void;
  onDiagnosticLog: (callback: (entry: DiagnosticLogEntry) => void) => () => void;
  onTrayAction: (callback: (action: 'toggle-mute' | 'open-settings') => void) => () => void;
  onBeforeWindowClose: (callback: () => void) => () => void;
  onWindowFullScreenChanged: (callback: (isFullScreen: boolean) => void) => () => void;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
}
