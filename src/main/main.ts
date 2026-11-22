import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
  webContents,
} from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  buildCanonicalUrl,
  buildWebRoomId,
  detectPlatformFromUrl,
  isLivePlatform,
  parseLiveInput,
  PLATFORMS,
  SAMPLE_CHANNELS,
  suggestWebSiteName,
} from '../shared/platforms';
import type {
  AppSettings,
  AuthStatusMap,
  ChannelPlatform,
  DirectStreamRequest,
  LiveStatusCheckItem,
  PaneSlot,
  PersistedState,
  PlatformId,
  ResolvedLiveInput,
  WindowBounds,
} from '../shared/types';
import {
  checkLiveStatuses,
  cleanupStreamExtractor,
  resolveDirectStream,
  resolveDouyuRealRid,
} from './stream-extractor';
import { DanmakuManager } from './danmaku-manager';
import {
  clearDiagnostics,
  getDiagnostics,
  recordDiagnostic,
  subscribeDiagnostics,
} from './diagnostics';
import {
  cancelActiveUpdateDownload,
  checkForAppUpdates,
  downloadUpdateAsset,
  installDownloadedUpdate,
  openSafeExternalUrl,
} from './updater';

// Enable hardware video decode + Windows HEVC (MediaFoundation) + GPU rasterization + auto-play
app.commandLine.appendSwitch(
  'enable-features',
  'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport'
);
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Prevent Chromium from auto-pausing or throttling live video when occluded or in background
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const LIVEHUB_PARTITION = 'persist:livehub';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isBossHidden = false;
let isQuitting = false;
let currentBossShortcut = 'Alt+X';
let latestWindowBounds: WindowBounds | undefined;
let lastSavedState: PersistedState | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let boundsSaveTimer: NodeJS.Timeout | null = null;
const loginWindows = new Map<PlatformId, BrowserWindow>();
const extraWindows = new Set<BrowserWindow>();
const freeWebContentsIds = new Set<number>();
const mobileWebContentsIds = new Set<number>();
let authSyncTimer: NodeJS.Timeout | null = null;
let lastEmittedAuthJson = '';
const danmakuManager = new DanmakuManager(
  (batch) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livehub:danmaku-batch', batch);
    }
  },
  {
    emitStatus: (ev) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('livehub:danmaku-status', ev);
      }
    },
    getSession: () => session.fromPartition(LIVEHUB_PARTITION),
  }
);

subscribeDiagnostics((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livehub:diagnostic-log', entry);
  }
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isBossHidden) {
    isBossHidden = false;
    mainWindow.webContents.send('livehub:boss-toggled', false);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function getStateFilePath(): string {
  return path.join(app.getPath('userData'), 'livehub-state.json');
}

function createDefaultPanes(): PaneSlot[] {
  return [0, 1, 2, 3].map((slotIndex) => ({
    slotIndex,
    channelId: null,
    url: null,
    platform: null,
    title: `画面 ${slotIndex + 1}`,
    muted: slotIndex !== 0,
    mode: 'pure',
    volume: 1,
    fitMode: 'contain',
  }));
}

function createDefaultSettings(): AppSettings {
  return {
    layout: '1x2',
    sidebarCollapsed: false,
    alwaysOnTop: false,
    globalMuted: false,
    soloSlotIndex: null,
    autoHighestQuality: true,
    hideGiftEffects: true,
    danmakuEnabled: true,
    danmakuArea: 'half',
    danmakuOpacity: 0.85,
    danmakuFontSize: 18,
    danmakuSpeed: 1,
    danmakuMode: 'scroll',
    danmakuBlockKeywords: [],
    theme: 'light',
    customGroups: [],
    hiddenDefaultGroups: [],
    splitRatios: { col: 50, row: 50 },
    bossKeyShortcut: 'Alt+X',
    panes: createDefaultPanes(),
  };
}

function createDefaultState(): PersistedState {
  return {
    channels: SAMPLE_CHANNELS,
    settings: createDefaultSettings(),
  };
}

async function loadPersistedState(): Promise<PersistedState> {
  const filePath = getStateFilePath();
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const defaults = createDefaultSettings();
    const panes = Array.isArray(parsed.settings?.panes) && parsed.settings.panes.length === 4
      ? parsed.settings.panes.map((p, idx) => ({
          ...defaults.panes[idx],
          ...p,
          slotIndex: idx,
        }))
      : defaults.panes;
    const loaded: PersistedState = {
      channels: Array.isArray(parsed.channels) ? parsed.channels : SAMPLE_CHANNELS,
      settings: {
        ...defaults,
        ...parsed.settings,
        panes,
      },
    };
    latestWindowBounds = loaded.settings.windowBounds;
    lastSavedState = loaded;
    return loaded;
  } catch {
    const fallback = createDefaultState();
    lastSavedState = fallback;
    return fallback;
  }
}

function savePersistedState(state: PersistedState): Promise<void> {
  const merged: PersistedState = {
    ...state,
    settings: {
      ...state.settings,
      ...(latestWindowBounds ? { windowBounds: latestWindowBounds } : {}),
    },
  };
  lastSavedState = merged;
  const serialized = JSON.stringify(merged, null, 2);

  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const filePath = getStateFilePath();
      const tmpPath = `${filePath}.tmp`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tmpPath, serialized, 'utf-8');
      await fs.rename(tmpPath, filePath);
    });
  return saveQueue;
}

async function computeAuthStatus(): Promise<AuthStatusMap> {
  const liveSession = session.fromPartition(LIVEHUB_PARTITION);
  const cookies = await liveSession.cookies.get({});

  const findCookie = (domainKeyword: string, names: string[]) =>
    cookies.find(
      (c) =>
        (c.domain || '').toLowerCase().includes(domainKeyword) &&
        names.includes(c.name) &&
        Boolean(c.value)
    );

  const huyaCookie = findCookie('huya.com', ['yyuid', 'udb_uid', 'username']);
  const huyaName = findCookie('huya.com', ['username'])?.value;
  const douyuCookie = findCookie('douyu.com', ['acf_auth', 'dy_auth', 'acf_uid', 'acf_username']);
  const douyuName = findCookie('douyu.com', ['acf_username', 'acf_uid'])?.value;
  const biliCookie = findCookie('bilibili.com', ['SESSDATA']);
  const biliUid = findCookie('bilibili.com', ['DedeUserID'])?.value;
  const douyinCookie = findCookie('douyin.com', [
    'sessionid',
    'sessionid_ss',
    'sid_tt',
    'uid_tt',
  ]);
  const douyinUid = findCookie('douyin.com', ['uid_tt'])?.value;

  const decodeSafe = (val?: string) => {
    if (!val) return undefined;
    try {
      return decodeURIComponent(val);
    } catch {
      return val;
    }
  };

  return {
    huya: {
      loggedIn: Boolean(huyaCookie),
      accountHint: huyaCookie ? decodeSafe(huyaName) || `UID ${huyaCookie.value}` : undefined,
    },
    douyu: {
      loggedIn: Boolean(douyuCookie),
      accountHint: douyuCookie ? decodeSafe(douyuName) || '已验证' : undefined,
    },
    bilibili: {
      loggedIn: Boolean(biliCookie),
      accountHint: biliCookie ? (biliUid ? `UID ${biliUid}` : '已验证') : undefined,
    },
    douyin: {
      loggedIn: Boolean(douyinCookie),
      accountHint: douyinCookie ? (douyinUid ? '账号已登录' : '已验证') : undefined,
    },
  };
}

function notifyAuthStatusChanged(changedPlatform?: PlatformId): void {
  if (authSyncTimer) clearTimeout(authSyncTimer);
  authSyncTimer = setTimeout(() => {
    void computeAuthStatus().then((status) => {
      const serialized = JSON.stringify(status);
      if (serialized === lastEmittedAuthJson) return;
      lastEmittedAuthJson = serialized;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('livehub:auth-changed', {
          status,
          changedPlatform,
        });
      }
      if (changedPlatform) {
        const popup = loginWindows.get(changedPlatform);
        if (popup && !popup.isDestroyed() && status[changedPlatform].loggedIn) {
          popup.setTitle(`${PLATFORMS[changedPlatform].name} — 登录成功！可关闭窗口（已解锁高画质 Cookie）`);
        }
      }
    });
  }, 400);
}

// Ad-source & P2P upload domains/paths (based on douyu-p2p-block, Huya-Ad-Skipper, better-douyin & live telemetry traces)
// Passing explicit URL patterns lets Chromium filter in C++ inside the Network Service without waking main-process JS
// on every normal video chunk / image / API request (critical for Douyin / Bilibili smooth playback).
const AD_AND_BLOAT_FILTER_URLS = [
  '*://*.va.huya.com/*',
  '*://*.p2p.huya.com/*',
  '*://statwup.huya.com/*',
  '*://ylog.huya.com/*',
  '*://stat.huya.com/*',
  '*://ad.huya.com/*',
  '*://*.ourdvsss.com/live*',
  '*://api.galaxyclouds.cn/p2p*',
  '*://*.congyicn.com/*',
  '*://proxy-tel-s.alicdn.com/f/pcdn*',
  '*://sdkapi.douyucdn.cn/p2p*',
  '*://dot.douyu.com/*',
  '*://rtb.douyu.com/*',
  '*://wan.douyu.com/*',
  '*://cm.bilibili.com/*',
  '*://data.bilibili.com/*',
  '*://*.hdslb.com/*bili-collect*',
  '*://*.bilibili.com/*bili-collect*',
  '*://*.bilibili.com/*reporter-pb/*',
  '*://ad.toutiao.com/*',
  '*://analytics.oceanengine.com/*',
  '*://mon.snssdk.com/*',
  '*://mon.zijieapi.com/*',
  '*://is.snssdk.com/ad*',
  '*://*.snssdk.com/*pangolin-sdk*',
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://hm.baidu.com/*',
  '*://*.cnzz.com/*',
  '*://pos.baidu.com/*',
  '*://cpro.baidu.com/*',
  '*://*.tanx.com/*',
  '*://*/*.svga',
  '*://*/*.svga?*',
  '*://*.huya.com/*sidebarNavGroup/*',
  '*://*.msstatic.com/*sidebarNavGroup/*',
  '*://*.huya.com/*anchorpost/*',
  '*://*.msstatic.com/*anchorpost/*',
  '*://*.hdslb.com/*bfs/activity-plat/*',
  '*://activity.hdslb.com/blackboard/*',
];

const HARD_AD_AND_P2P_RE =
  /(\.va\.huya\.com|\.p2p\.huya\.com|statwup\.huya\.com|ylog\.huya\.com|stat\.huya\.com|ad\.huya\.com|ourdvsss\.com\/live\?msg=getpeer|api\.galaxyclouds\.cn\/p2p|congyicn\.com\/(?:FlashP2PMonitorNew|dist\/yhp2p)|proxy-tel-s\.alicdn\.com\/f\/pcdn|sdkapi\.douyucdn\.cn\/p2p|dot\.douyu\.com|rtb\.douyu\.com|wan\.douyu\.com|cm\.bilibili\.com|data\.bilibili\.com|bili-collect\.js|reporter-pb\/|ad\.toutiao\.com|analytics\.oceanengine\.com|mon\.snssdk\.com|mon\.zijieapi\.com|is\.snssdk\.com\/ad|pangolin-sdk|doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|hm\.baidu\.com|cnzz\.com|pos\.baidu\.com|cpro\.baidu\.com|tanx\.com)/i;

const BLOAT_BLOCK_RE =
  /(\.svga(\?|$)|sidebarNavGroup\/|anchorpost\/|bfs\/activity-plat\/|activity\.hdslb\.com\/blackboard\/)/i;

const AUTH_COOKIE_NAMES_BY_PLATFORM: Record<PlatformId, Set<string>> = {
  huya: new Set(['yyuid', 'udb_uid', 'username']),
  douyu: new Set(['acf_auth', 'dy_auth', 'acf_uid', 'acf_username']),
  bilibili: new Set(['SESSDATA', 'DedeUserID']),
  douyin: new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt']),
};

let mobileHeaderHookWide = false;

function refreshLiveSessionHeaderHooks(force = false): void {
  const needWide = mobileWebContentsIds.size > 0;
  if (!force && needWide === mobileHeaderHookWide) return;
  mobileHeaderHookWide = needWide;

  const liveSession = session.fromPartition(LIVEHUB_PARTITION);
  const urls = needWide
    ? ['http://*/*', 'https://*/*']
    : [
        'https://api.live.bilibili.com/*',
        'https://api.bilibili.com/*',
        'https://www.douyu.com/*',
      ];

  liveSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const isMobileWeb =
      needWide &&
      typeof details.webContentsId === 'number' &&
      mobileWebContentsIds.has(details.webContentsId);
    const needsBiliOrDouyuHeaders =
      details.url.startsWith('https://api.live.bilibili.com/') ||
      details.url.startsWith('https://api.bilibili.com/') ||
      details.url.startsWith('https://www.douyu.com/');

    if (!isMobileWeb && !needsBiliOrDouyuHeaders) {
      callback({});
      return;
    }

    const headers = { ...details.requestHeaders };

    if (isMobileWeb) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (
          lower === 'sec-ch-ua' ||
          lower === 'sec-ch-ua-full-version-list' ||
          lower === 'sec-ch-ua-platform-version'
        ) {
          delete headers[key];
        }
      }
      headers['Sec-CH-UA-Mobile'] = '?1';
      headers['Sec-CH-UA-Platform'] = '"iOS"';
    }

    if (needsBiliOrDouyuHeaders) {
      const hasRef = Object.keys(headers).some((k) => k.toLowerCase() === 'referer');
      const hasOrigin = Object.keys(headers).some((k) => k.toLowerCase() === 'origin');
      if (details.url.includes('douyu.com')) {
        if (!hasRef) headers['Referer'] = 'https://www.douyu.com/';
        if (!hasOrigin) headers['Origin'] = 'https://www.douyu.com';
      } else {
        if (!hasRef) headers['Referer'] = 'https://live.bilibili.com/';
        if (!hasOrigin) headers['Origin'] = 'https://live.bilibili.com';
      }
    }

    callback({ requestHeaders: headers });
  });
}

function setMobileWebContentsFlag(webContentsId: number, isMobile: boolean): void {
  const changed = isMobile
    ? !mobileWebContentsIds.has(webContentsId)
    : mobileWebContentsIds.has(webContentsId);
  if (!changed) return;
  if (isMobile) {
    mobileWebContentsIds.add(webContentsId);
  } else {
    mobileWebContentsIds.delete(webContentsId);
  }
  refreshLiveSessionHeaderHooks(false);
}

function configureLiveSession(): void {
  const liveSession = session.fromPartition(LIVEHUB_PARTITION);
  liveSession.setUserAgent(DEFAULT_UA);

  // Intercept only ad sources, P2P upload nodes, telemetry beacons, and heavy promo bloat
  liveSession.webRequest.onBeforeRequest({ urls: AD_AND_BLOAT_FILTER_URLS }, (details, callback) => {
    if (details.resourceType !== 'mainFrame' && HARD_AD_AND_P2P_RE.test(details.url)) {
      callback({ cancel: true });
      return;
    }
    if (
      details.resourceType !== 'mainFrame' &&
      details.resourceType !== 'subFrame' &&
      details.resourceType !== 'stylesheet' &&
      details.resourceType !== 'media' &&
      details.resourceType !== 'webSocket' &&
      BLOAT_BLOCK_RE.test(details.url)
    ) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  // Narrow Referer/Origin hook by default; widens automatically only while a mobile-mode webview is open
  refreshLiveSessionHeaderHooks(true);

  // Explicitly approve fullscreen, media, DRM (mediaKeySystem), pointerLock & copy-link clipboard write inside webviews
  liveSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'fullscreen' ||
        permission === 'media' ||
        permission === 'mediaKeySystem' ||
        permission === 'pointerLock' ||
        permission === 'clipboard-sanitized-write'
    );
  });

  liveSession.cookies.on('changed', (_event, cookie, cause, removed) => {
    // Ignore transient overwrite removals & non-auth tracking cookie rotations (e.g. Douyin msToken/ttwid)
    if (removed && cause === 'overwrite') return;
    const domain = (cookie.domain || '').toLowerCase();
    let changedPlatform: PlatformId | undefined;
    if (domain.includes('huya.com')) changedPlatform = 'huya';
    else if (domain.includes('douyu.com')) changedPlatform = 'douyu';
    else if (domain.includes('bilibili.com')) changedPlatform = 'bilibili';
    else if (domain.includes('douyin.com')) changedPlatform = 'douyin';
    if (changedPlatform && AUTH_COOKIE_NAMES_BY_PLATFORM[changedPlatform].has(cookie.name)) {
      notifyAuthStatusChanged(changedPlatform);
    }
  });
}

function openAuthPopupWindow(
  targetUrl: string,
  title?: string,
  platform?: PlatformId,
  allowDuplicatePopup = false
): void {
  if (platform && !allowDuplicatePopup) {
    const existing = loginWindows.get(platform);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
  }

  const popup = new BrowserWindow({
    width: 1080,
    height: 760,
    parent: mainWindow ?? undefined,
    title: title || '平台账号登录（Cookie 自动同步至所有画面）',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      partition: LIVEHUB_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  popup.webContents.setUserAgent(DEFAULT_UA);

  // Allow third-party OAuth (WeChat / QQ) popups inside the exact same partition
  popup.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        openAuthPopupWindow(url, '第三方快捷授权登录', platform, true);
      }
    } catch {
      // Ignore malformed URLs
    }
    return { action: 'deny' };
  });

  extraWindows.add(popup);
  popup.on('closed', () => {
    extraWindows.delete(popup);
  });

  if (platform) {
    if (!allowDuplicatePopup) {
      loginWindows.set(platform, popup);
    }
    popup.on('closed', () => {
      if (!allowDuplicatePopup && loginWindows.get(platform) === popup) {
        loginWindows.delete(platform);
      }
      if (!isQuitting) {
        notifyAuthStatusChanged(platform);
      }
    });
  }

  void popup.loadURL(targetUrl).catch(() => {});
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function createTrayIconImage(): Electron.NativeImage {
  // Draw a crisp 32x32 rounded-square blue-purple prism icon with a white play triangle
  const w = 32;
  const h = 32;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    raw[rowStart] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      const px = rowStart + 1 + x * 4;
      const nx = (x + 0.5) / w;
      const ny = (y + 0.5) / h;
      // Rounded square SDF (radius 7/32)
      const dx = Math.max(0, Math.abs(nx - 0.5) - 0.27);
      const dy = Math.max(0, Math.abs(ny - 0.5) - 0.27);
      const dist = Math.hypot(dx, dy);
      const radius = 0.21;
      if (dist <= radius + 0.025) {
        const edgeAlpha = dist <= radius ? 1 : Math.max(0, 1 - (dist - radius) / 0.025);
        // Gradient #007aff -> #5856d6 -> #af52de
        const t = Math.min(1, Math.max(0, (nx + ny) * 0.5));
        let r = Math.round(0 + t * 145);
        let g = Math.round(122 - t * 38);
        let b = Math.round(255 - t * 33);
        // White play triangle inside
        const tx = (nx - 0.37) / 0.34;
        const ty = Math.abs(ny - 0.5) / 0.23;
        if (tx >= 0 && tx <= 1 && ty <= 1 - tx) {
          r = 255;
          g = 255;
          b = 255;
        }
        raw[px] = r;
        raw[px + 1] = g;
        raw[px + 2] = b;
        raw[px + 3] = Math.round(edgeAlpha * 255);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isBossHidden) {
    isBossHidden = false;
    mainWindow.webContents.send('livehub:boss-toggled', false);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !isBossHidden);
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? '隐藏到托盘' : '显示 YourOwn Live 主窗口',
      click: () => {
        if (visible) {
          mainWindow?.hide();
          updateTrayMenu();
        } else {
          showMainWindow();
        }
      },
    },
    {
      label: isBossHidden ? `退出老板键恢复 (${currentBossShortcut || '无'})` : `老板键一键静音隐藏 (${currentBossShortcut || '无'})`,
      click: () => {
        toggleBossMode();
      },
    },
    {
      label: '全局静音 / 恢复声音',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('livehub:tray-action', 'toggle-mute');
        }
      },
    },
    {
      label: '账号管理与诊断日志',
      click: () => {
        showMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('livehub:tray-action', 'open-settings');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出 YourOwn Live',
      click: () => {
        void shutdownAndExit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(createTrayIconImage());
    tray.setToolTip('YourOwn Live — 打造你的纯净无广告直播看播台');
    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (isBossHidden || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        showMainWindow();
      } else {
        mainWindow.focus();
      }
    });
    updateTrayMenu();
  } catch (err) {
    recordDiagnostic(
      'warn',
      'window',
      `系统托盘初始化失败：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function captureWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
  const isMaximized = mainWindow.isMaximized();
  const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  latestWindowBounds = {
    x: b.x,
    y: b.y,
    width: Math.max(980, b.width),
    height: Math.max(620, b.height),
    isMaximized,
  };
}

function scheduleBoundsPersist(): void {
  captureWindowBounds();
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    if (lastSavedState && !isQuitting) {
      void savePersistedState(lastSavedState);
    }
  }, 600);
}

function validateSavedBounds(saved?: WindowBounds): WindowBounds {
  const fallback: WindowBounds = { width: 1480, height: 920, isMaximized: false };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return fallback;
  }
  const width = Math.max(980, Math.round(saved.width));
  const height = Math.max(620, Math.round(saved.height));
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    const displays = screen.getAllDisplays();
    const visibleOnAny = displays.some((d) => {
      const wa = d.workArea;
      return (
        saved.x! + width > wa.x + 80 &&
        saved.x! < wa.x + wa.width - 80 &&
        saved.y! + height > wa.y + 60 &&
        saved.y! < wa.y + wa.height - 60
      );
    });
    if (visibleOnAny) {
      return {
        x: Math.round(saved.x),
        y: Math.round(saved.y),
        width,
        height,
        isMaximized: Boolean(saved.isMaximized),
      };
    }
  }
  return { width, height, isMaximized: Boolean(saved.isMaximized) };
}

async function shutdownAndExit(): Promise<void> {
  if (isQuitting) return;
  isQuitting = true;
  void cancelActiveUpdateDownload();

  if (boundsSaveTimer) {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
  }
  if (authSyncTimer) {
    clearTimeout(authSyncTimer);
    authSyncTimer = null;
  }

  captureWindowBounds();

  // Ask renderer to flush any unsaved debounced state before closing
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('livehub:before-close');
      await new Promise((resolve) => setTimeout(resolve, 180));
    } catch {
      // Ignore
    }
  }

  if (lastSavedState) {
    try {
      await Promise.race([
        savePersistedState(lastSavedState),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    } catch {
      // Ignore save errors on exit
    }
  } else {
    await Promise.race([
      saveQueue.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
  }

  danmakuManager.stopAll();
  cleanupStreamExtractor();
  globalShortcut.unregisterAll();

  if (tray) {
    try {
      tray.destroy();
    } catch {
      // Ignore
    }
    tray = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  for (const win of Array.from(loginWindows.values())) {
    if (!win.isDestroyed()) win.destroy();
  }
  loginWindows.clear();

  for (const win of Array.from(extraWindows)) {
    if (!win.isDestroyed()) win.destroy();
  }
  extraWindows.clear();

  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.getType() === 'webview' && !wc.isDestroyed()) {
        wc.setAudioMuted(true);
        wc.close({ waitForBeforeUnload: false });
      }
    } catch {
      // Ignore already-disposed webContents
    }
  }

  try {
    const liveSession = session.fromPartition(LIVEHUB_PARTITION);
    liveSession.flushStorageData();
    await Promise.race([
      liveSession.cookies.flushStore(),
      new Promise((resolve) => setTimeout(resolve, 350)),
    ]);
  } catch {
    // Ignore storage flush errors during shutdown
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  mainWindow = null;

  app.exit(0);
}

function toggleBossMode(): boolean {
  if (!mainWindow) return false;
  if (isBossHidden) {
    isBossHidden = false;
    mainWindow.show();
    mainWindow.focus();
  } else {
    isBossHidden = true;
    mainWindow.hide();
  }
  mainWindow.webContents.send('livehub:boss-toggled', isBossHidden);
  updateTrayMenu();
  return isBossHidden;
}

function registerBossShortcut(shortcut: string): { ok: boolean; error?: string } {
  try {
    globalShortcut.unregisterAll();
    const trimmed = shortcut.trim();
    if (!trimmed) {
      currentBossShortcut = '';
      updateTrayMenu();
      return { ok: true };
    }
    const success = globalShortcut.register(trimmed, () => {
      toggleBossMode();
    });
    if (!success) {
      if (currentBossShortcut && currentBossShortcut !== trimmed) {
        globalShortcut.register(currentBossShortcut, () => {
          toggleBossMode();
        });
      }
      return { ok: false, error: `快捷键 ${trimmed} 注册失败，可能被其他软件占用` };
    }
    currentBossShortcut = trimmed;
    updateTrayMenu();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '快捷键格式无效',
    };
  }
}

function createMainWindow(initialState: PersistedState): void {
  Menu.setApplicationMenu(null);

  const bounds = validateSavedBounds(initialState.settings.windowBounds);
  const startDark = initialState.settings.theme === 'dark';

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 980,
    minHeight: 620,
    title: 'YourOwn Live — 打造你的纯净无广告直播看播台',
    icon: createTrayIconImage(),
    backgroundColor: startDark ? '#0e1116' : '#f5f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: startDark ? '#f5f5f7' : '#1d1d1f',
      height: 50,
    },
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  if (bounds.isMaximized) {
    mainWindow.maximize();
  }
  captureWindowBounds();

  mainWindow.on('resize', scheduleBoundsPersist);
  mainWindow.on('move', scheduleBoundsPersist);
  mainWindow.on('maximize', scheduleBoundsPersist);
  mainWindow.on('unmaximize', scheduleBoundsPersist);
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livehub:fullscreen-changed', true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livehub:fullscreen-changed', false);
    }
  });
  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
    captureWindowBounds();
    updateTrayMenu();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[YourOwn Live] did-fail-load:', code, desc, url);
    recordDiagnostic('error', 'window', `页面加载失败 (${code}): ${desc}`);
  });

  // Synchronously tag free-web <webview> instances (no preload script) in FIFO order before first navigation,
  // and isolate zoom per webview so split panes of the same origin never overwrite each other's zoom level.
  const pendingWebviewMeta: Array<{ isFreeWeb: boolean; isMobile: boolean }> = [];
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    const isFreeWeb = !webPreferences.preload;
    const isMobile = /iPhone|Mobile/i.test(params?.useragent || '');
    pendingWebviewMeta.push({ isFreeWeb, isMobile });
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    const meta = pendingWebviewMeta.shift();
    try {
      if (typeof guestContents.setZoomMode === 'function') {
        guestContents.setZoomMode('isolated');
      }
    } catch {
      // Ignore if unsupported
    }
    if (meta?.isFreeWeb) {
      freeWebContentsIds.add(guestContents.id);
      setMobileWebContentsFlag(
        guestContents.id,
        Boolean(meta.isMobile || /iPhone|Mobile/i.test(guestContents.getUserAgent() || ''))
      );
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl).catch((err) => {
      console.error('[YourOwn Live] loadURL failed:', err);
    });
  } else {
    void mainWindow
      .loadFile(path.join(__dirname, '../../dist/index.html'))
      .catch((err) => {
        console.error('[YourOwn Live] loadFile failed:', err);
      });
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      void shutdownAndExit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!isQuitting) {
      void shutdownAndExit();
    }
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-prevent-unload', (unloadEvent) => {
    unloadEvent.preventDefault();
  });

  if (contents.getType() === 'webview') {
    const existingUa = contents.getUserAgent();
    if (!existingUa || existingUa.includes('Electron/')) {
      contents.setUserAgent(DEFAULT_UA);
    }

    try {
      if (typeof contents.setZoomMode === 'function') {
        contents.setZoomMode('isolated');
      }
    } catch {
      // Ignore if unsupported
    }

    contents.once('destroyed', () => {
      freeWebContentsIds.delete(contents.id);
      setMobileWebContentsFlag(contents.id, false);
    });

    // Block custom desktop client protocol launches & prevent offline Douyin room from jumping to plaza
    contents.on('will-navigate', (navEvent, navigationUrl) => {
      try {
        const parsed = new URL(navigationUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          navEvent.preventDefault();
          return;
        }
        if (freeWebContentsIds.has(contents.id)) {
          return;
        }
        // Prevent Douyin offline room (live.douyin.com/{digits}) from redirecting to live plaza (live.douyin.com/)
        const currentUrl = contents.getURL();
        if (currentUrl) {
          const cur = new URL(currentUrl);
          const curIsDouyinRoom =
            cur.hostname.includes('live.douyin.com') && /^\/\d+\/?$/.test(cur.pathname);
          const nextIsDouyinPlaza =
            parsed.hostname.includes('live.douyin.com') &&
            (parsed.pathname === '/' || parsed.pathname === '' || parsed.pathname.startsWith('/category'));
          if (curIsDouyinRoom && nextIsDouyinPlaza) {
            navEvent.preventDefault();
          }
        }
      } catch {
        navEvent.preventDefault();
      }
    });

    // Intercept window.open inside webview: allow login/auth popups, navigate in-place for free-web panes
    contents.setWindowOpenHandler((details) => {
      const { url, referrer } = details;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { action: 'deny' };
        }
        const currentHref = contents.getURL();
        const loadOpts =
          referrer && referrer.url
            ? { httpReferrer: referrer }
            : currentHref && /^https?:/i.test(currentHref)
              ? { httpReferrer: currentHref }
              : undefined;
        if (freeWebContentsIds.has(contents.id)) {
          const isThirdPartyOAuth = /open\.weixin\.qq\.com|graph\.qq\.com|ptlogin/i.test(url);
          if (isThirdPartyOAuth) {
            const detected =
              detectPlatformFromUrl(url) ?? detectPlatformFromUrl(currentHref) ?? undefined;
            openAuthPopupWindow(url, '第三方快捷授权登录', detected, true);
            return { action: 'deny' };
          }
          // In free-web mode (e.g., Bilibili video cards with target="_blank"), open seamlessly in-place with Referer preserved
          setImmediate(() => {
            if (!contents.isDestroyed()) {
              void contents.loadURL(url, loadOpts).catch(() => {});
            }
          });
          return { action: 'deny' };
        }
        const isAuthUrl =
          /passport|login|oauth|qr|ptlogin|open\.weixin|graph\.qq|sso/i.test(url);
        if (isAuthUrl) {
          const detected =
            detectPlatformFromUrl(url) ?? detectPlatformFromUrl(currentHref) ?? undefined;
          const isThirdPartyOAuth = /open\.weixin\.qq\.com|graph\.qq\.com|ptlogin/i.test(url);
          openAuthPopupWindow(url, undefined, detected, isThirdPartyOAuth);
          return { action: 'deny' };
        }
        // Navigate in-place if it's a valid live room link, deny random promo tabs
        if (/huya\.com|douyu\.com|bilibili\.com|douyin\.com/i.test(parsed.hostname)) {
          setImmediate(() => {
            if (!contents.isDestroyed()) {
              void contents.loadURL(url, loadOpts).catch(() => {});
            }
          });
        }
        return { action: 'deny' };
      } catch {
        return { action: 'deny' };
      }
    });

    // Native right-click menu for free-web panes (sites with custom menus like Bilibili player preventDefault automatically)
    contents.on('context-menu', (_ev, params) => {
      if (!freeWebContentsIds.has(contents.id) || contents.isDestroyed()) return;
      const template: Electron.MenuItemConstructorOptions[] = [];
      const hasLink = Boolean(params.linkURL && /^https?:\/\//i.test(params.linkURL));
      if (hasLink) {
        template.push(
          {
            label: '在当前分屏打开链接',
            click: () => {
              if (!contents.isDestroyed()) {
                const cur = contents.getURL();
                void contents
                  .loadURL(
                    params.linkURL,
                    cur && /^https?:/i.test(cur) ? { httpReferrer: cur } : undefined
                  )
                  .catch(() => {});
              }
            },
          },
          {
            label: '在系统浏览器打开链接',
            click: () => {
              void openSafeExternalUrl(params.linkURL);
            },
          },
          {
            label: '复制链接地址',
            click: () => {
              void clipboard.writeText(params.linkURL).catch(() => {});
            },
          },
          { type: 'separator' }
        );
      }

      if (params.isEditable) {
        template.push(
          { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
          { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
          { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
          { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll },
          { type: 'separator' }
        );
      } else if (params.selectionText?.trim()) {
        template.push(
          { label: '复制选中内容', role: 'copy' },
          { type: 'separator' }
        );
      }

      template.push(
        {
          label: '后退',
          enabled: contents.navigationHistory.canGoBack(),
          click: () => {
            if (!contents.isDestroyed() && contents.navigationHistory.canGoBack()) {
              contents.navigationHistory.goBack();
            }
          },
        },
        {
          label: '前进',
          enabled: contents.navigationHistory.canGoForward(),
          click: () => {
            if (!contents.isDestroyed() && contents.navigationHistory.canGoForward()) {
              contents.navigationHistory.goForward();
            }
          },
        },
        {
          label: '刷新页面',
          click: () => {
            if (!contents.isDestroyed()) contents.reload();
          },
        }
      );

      const curUrl = contents.getURL();
      if (curUrl && /^https?:\/\//i.test(curUrl)) {
        template.push(
          { type: 'separator' },
          {
            label: '复制当前网址',
            click: () => {
              void clipboard.writeText(curUrl).catch(() => {});
            },
          },
          {
            label: '在系统浏览器打开当前页',
            click: () => {
              void openSafeExternalUrl(curUrl);
            },
          }
        );
      }

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: mainWindow ?? undefined });
    });
  }
});

const streamHostReferers = new Map<string, string>();

const KNOWN_STREAM_REFERERS: Array<[RegExp, string]> = [
  [/(bilivideo\.(com|cn)|smtcdns\.net|hdslb\.com)$/i, 'https://live.bilibili.com/'],
  [/(huya\.com|msstatic\.com|hycdn\.cn)$/i, 'https://www.huya.com/'],
  [/(douyucdn\.cn|douyucdn2\.cn|edgesrv\.com|akmcdn\.com|bytefcdn)/i, 'https://www.douyu.com/'],
  [/(douyincdn\.com|douyinpic\.com|douyinliving\.com|amemv\.com|snssdk\.com|bytecdn\.cn|ibytedtos\.com)/i, 'https://live.douyin.com/'],
];

function registerStreamHost(streamUrl: string | undefined, referer: string, baseUrl?: string): void {
  if (!streamUrl || !referer) return;
  try {
    const u = baseUrl ? new URL(streamUrl, baseUrl) : new URL(streamUrl);
    if (u.hostname) {
      streamHostReferers.set(u.hostname.toLowerCase(), referer);
    }
  } catch {
    // Ignore malformed URLs
  }
}

function matchStreamReferer(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const exact = streamHostReferers.get(host);
    if (exact) return exact;
    for (const [re, ref] of KNOWN_STREAM_REFERERS) {
      if (re.test(host)) return ref;
    }
    return null;
  } catch {
    return null;
  }
}

function configureDirectStreamNetworking(): void {
  const defaultSes = session.defaultSession;

  defaultSes.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'fullscreen' ||
        permission === 'media' ||
        permission === 'pointerLock' ||
        permission === 'clipboard-sanitized-write'
    );
  });

  defaultSes.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const ref = matchStreamReferer(details.url);
      if (!ref) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const headers = { ...details.requestHeaders };
      // Strip Origin (file:// / localhost) so live CDNs do not reject with 403
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'origin' || key.toLowerCase() === 'referer') {
          delete headers[key];
        }
      }
      headers['Referer'] = ref;
      headers['User-Agent'] = DEFAULT_UA;
      callback({ requestHeaders: headers });
    }
  );

  defaultSes.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const ref = matchStreamReferer(details.url);
      if (!ref) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const responseHeaders = { ...(details.responseHeaders || {}) };

      // Propagate referer across 301/302 CDN edge redirects
      if (details.statusCode >= 300 && details.statusCode < 400) {
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (k.toLowerCase() === 'location' && Array.isArray(v) && v[0]) {
            registerStreamHost(v[0], ref, details.url);
          }
        }
      }

      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase().startsWith('access-control-allow-')) {
          delete responseHeaders[key];
        }
      }
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
      responseHeaders['Access-Control-Expose-Headers'] = ['*'];
      callback({ responseHeaders });
    }
  );
}

app.whenReady().then(async () => {
  configureLiveSession();
  configureDirectStreamNetworking();

  const initialState = await loadPersistedState();
  currentBossShortcut = initialState.settings.bossKeyShortcut || 'Alt+X';
  registerBossShortcut(currentBossShortcut);

  ipcMain.handle('livehub:load-state', async () => loadPersistedState());
  ipcMain.handle('livehub:save-state', async (_event, state: PersistedState) => {
    await savePersistedState(state);
  });

  ipcMain.handle('livehub:set-always-on-top', (_event, flag: boolean) => {
    if (!mainWindow) return false;
    mainWindow.setAlwaysOnTop(Boolean(flag), 'screen-saver');
    return mainWindow.isAlwaysOnTop();
  });

  ipcMain.handle('livehub:set-window-fullscreen', (_event, flag: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const next = Boolean(flag);
    if (mainWindow.isFullScreen() !== next) {
      mainWindow.setFullScreen(next);
    }
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('livehub:toggle-boss-hide', () => toggleBossMode());

  ipcMain.handle('livehub:set-boss-key', (_event, shortcut: string) =>
    registerBossShortcut(shortcut)
  );

  ipcMain.handle('livehub:open-login', (_event, platform: PlatformId) => {
    const meta = PLATFORMS[platform];
    if (!meta) return;
    openAuthPopupWindow(
      meta.loginUrl,
      `${meta.name} — 扫码/账号登录（Cookie 本地持久化）`,
      platform
    );
  });

  ipcMain.handle('livehub:get-auth-status', async () => computeAuthStatus());

  ipcMain.handle('livehub:clear-cookies', async (_event, platform?: PlatformId) => {
    const liveSession = session.fromPartition(LIVEHUB_PARTITION);
    if (!platform) {
      await liveSession.clearStorageData({ storages: ['cookies'] });
      return computeAuthStatus();
    }
    const meta = PLATFORMS[platform];
    if (!meta) return computeAuthStatus();
    const cookies = await liveSession.cookies.get({});
    for (const cookie of cookies) {
      const domain = cookie.domain?.replace(/^\./, '') || '';
      if (meta.domainPatterns.some((pattern) => domain.includes(pattern))) {
        const scheme = cookie.secure ? 'https' : 'http';
        const cookieUrl = `${scheme}://${domain}${cookie.path || '/'}`;
        await liveSession.cookies.remove(cookieUrl, cookie.name);
      }
    }
    return computeAuthStatus();
  });

  ipcMain.handle('livehub:get-webview-preload', () => {
    const rawPath = path.join(__dirname, 'webview-preload.js');
    const unpackedPath = rawPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const resolved = unpackedPath !== rawPath && existsSync(unpackedPath) ? unpackedPath : rawPath;
    return pathToFileURL(resolved).toString();
  });

  ipcMain.handle(
    'livehub:wake-webview',
    async (_event, webContentsId: number, width = 800, height = 500) => {
      try {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return;
        const cx = Math.max(40, Math.round(width * 0.5));
        const cy = Math.max(40, Math.round(height * 0.5));
        const bx = Math.max(60, Math.round(width * 0.72));
        const by = Math.max(40, Math.round(height - 36));
        wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
        await new Promise((r) => setTimeout(r, 80));
        wc.sendInputEvent({ type: 'mouseMove', x: bx, y: by });
      } catch {
        // Ignore if webContents was disposed
      }
    }
  );

  ipcMain.handle(
    'livehub:register-free-web',
    (_event, webContentsId: number) => {
      if (typeof webContentsId === 'number' && Number.isFinite(webContentsId)) {
        freeWebContentsIds.add(webContentsId);
        const wc = webContents.fromId(webContentsId);
        if (wc && !wc.isDestroyed()) {
          try {
            if (typeof wc.setZoomMode === 'function') {
              wc.setZoomMode('isolated');
            }
          } catch {
            // Ignore
          }
          setMobileWebContentsFlag(webContentsId, /iPhone|Mobile/i.test(wc.getUserAgent() || ''));
        }
      }
    }
  );

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function resolveShortLiveInput(
  rawInput: string,
  fallbackPlatform?: ChannelPlatform
): Promise<ResolvedLiveInput> {
  const initial = parseLiveInput(rawInput, fallbackPlatform);
  if (initial.ok) {
    // For Douyu vanity/short numeric room IDs (e.g. 728 -> 12821), keep user's friendly URL/roomId
    // or enrich suggestedName when available, while stream-extractor/danmaku resolve real rid automatically.
    if (initial.platform === 'douyu') {
      try {
        const resolved = await resolveDouyuRealRid(initial.roomId);
        return {
          ...initial,
          roomId: resolved.rid || initial.roomId,
          url: buildCanonicalUrl('douyu', resolved.rid || initial.roomId),
          suggestedName: initial.suggestedName || resolved.room?.nickname,
          suggestedCategory:
            (resolved.room?.second_lvl_name || resolved.room?.cate_name || '').trim() || undefined,
        };
      } catch {
        return initial;
      }
    }
    return initial;
  }
  if (!initial.needsShortResolve || !initial.shortUrl) {
    return {
      ok: false,
      needsPlatform: initial.needsPlatform,
      roomId: initial.roomId,
      suggestedName: initial.suggestedName,
      reason: initial.reason,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7500);
  try {
    // Follow redirects step-by-step so offline Douyin rooms don't silently lose room_id/web_rid by redirecting to live.douyin.com/
    const visitedUrls: string[] = [initial.shortUrl];
    let currentUrl = initial.shortUrl;
    let lastResp: Response | null = null;
    for (let hop = 0; hop < 8; hop++) {
      const resp = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      lastResp = resp;
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        try {
          const nextUrl = new URL(loc, currentUrl).toString();
          visitedUrls.push(nextUrl);
          currentUrl = nextUrl;
          continue;
        } catch {
          break;
        }
      }
      break;
    }

    const finalUrl = currentUrl;
    // Check visited URLs (preferring specific live room URLs first; NEVER accept Douyin plaza 'home' as a short-link match!)
    for (let i = visitedUrls.length - 1; i >= 0; i--) {
      const candidate = parseLiveInput(visitedUrls[i], initial.platformHint);
      if (
        candidate.ok &&
        isLivePlatform(candidate.platform) &&
        !(candidate.platform === 'douyin' && candidate.roomId === 'home')
      ) {
        if (candidate.platform === 'douyu') {
          const resolved = await resolveDouyuRealRid(candidate.roomId).catch(() => null);
          const finalRid = resolved?.rid || candidate.roomId;
          return {
            ...candidate,
            roomId: finalRid,
            url: buildCanonicalUrl('douyu', finalRid),
            suggestedName: candidate.suggestedName || initial.suggestedName || resolved?.room?.nickname,
          };
        }
        return {
          ...candidate,
          suggestedName: candidate.suggestedName || initial.suggestedName,
        };
      }
    }

    const htmlText = lastResp ? await lastResp.text().catch(() => '') : '';

    // Douyu short links / topic pages
    if (
      initial.platformHint === 'douyu' ||
      visitedUrls.some((u) => /douyu\.com|douyucdn\.cn/i.test(u))
    ) {
      const ridFromUrl = visitedUrls
        .map((u) => u.match(/[?&](?:rid|roomId|room_id)=(\d+)/)?.[1])
        .find(Boolean);
      const ridFromHtml =
        htmlText.match(/"rid"\s*:\s*(\d+)/)?.[1] ||
        htmlText.match(/room_id["']?\s*[:=]\s*["']?(\d+)/)?.[1] ||
        htmlText.match(/\$ROOM\.room_id\s*=\s*(\d+)/)?.[1];
      const rawRid = ridFromUrl || ridFromHtml;
      if (rawRid) {
        const resolved = await resolveDouyuRealRid(rawRid).catch(() => null);
        const finalRid = resolved?.rid || rawRid;
        return {
          ok: true,
          platform: 'douyu',
          roomId: finalRid,
          url: buildCanonicalUrl('douyu', finalRid),
          suggestedName: initial.suggestedName || resolved?.room?.nickname,
        };
      }
      return {
        ok: false,
        needsPlatform: false,
        reason: '未能从该斗鱼链接解析出房间号，请直接粘贴直播间链接或输入斗鱼房间号',
      };
    }

    // Douyin short links & reflow links (works even when the streamer is currently offline!)
    if (
      initial.platformHint === 'douyin' ||
      visitedUrls.some((u) => /douyin|iesdouyin|amemv/i.test(u))
    ) {
      let roomId: string | undefined;
      let webRid: string | undefined;
      for (const u of visitedUrls) {
        if (!webRid) {
          webRid =
            u.match(/[?&]web_rid=(\d+)/)?.[1] ||
            u.match(/live\.douyin\.com\/(\d+)/)?.[1];
        }
        if (!roomId) {
          roomId =
            u.match(/\/reflow\/(\d+)/)?.[1] ||
            u.match(/\/share\/live\/(\d+)/)?.[1] ||
            u.match(/[?&]room_id=(\d+)/)?.[1];
        }
      }

      let nickname: string | undefined;

      if (roomId) {
        try {
          const infoResp = await fetch(
            `https://webcast.amemv.com/webcast/room/reflow/info/?type_id=0&live_id=1&room_id=${roomId}&app_id=1128`,
            {
              signal: controller.signal,
              headers: { 'User-Agent': MOBILE_UA },
            }
          );
          const infoJson = (await infoResp.json().catch(() => null)) as {
            data?: { room?: { owner?: { web_rid?: string; nickname?: string } } };
          } | null;
          webRid = infoJson?.data?.room?.owner?.web_rid || webRid;
          nickname = infoJson?.data?.room?.owner?.nickname || undefined;
        } catch {
          // Ignore reflow API lookup failures and fallback below
        }
      }

      if (!webRid && htmlText) {
        const htmlWebRid =
          htmlText.match(/"web_rid"\s*:\s*"(\d+)"/) ||
          htmlText.match(/web_rid=(\d+)/);
        webRid = htmlWebRid?.[1];
      }

      if (webRid) {
        return {
          ok: true,
          platform: 'douyin',
          roomId: webRid,
          url: buildCanonicalUrl('douyin', webRid),
          suggestedName: nickname || initial.suggestedName,
        };
      }

      // If this was a regular Douyin short video / profile share link (not a live room), open as free web!
      if (/^https?:\/\//i.test(finalUrl) && !/live\.douyin\.com\/?(\?|$)/i.test(finalUrl)) {
        return {
          ok: true,
          platform: 'web',
          roomId: buildWebRoomId(finalUrl),
          url: finalUrl,
          suggestedName: initial.suggestedName || suggestWebSiteName(finalUrl),
        };
      }

      return {
        ok: false,
        needsPlatform: false,
        reason: '该抖音分享链接已失效或主播已下播未返回房间号，请粘贴 live.douyin.com/房间号',
      };
    }

    // Non-live short link target (e.g. b23.tv -> bilibili.com/video/BV...): open seamlessly as free web
    if (/^https?:\/\//i.test(finalUrl)) {
      return {
        ok: true,
        platform: 'web',
        roomId: buildWebRoomId(finalUrl),
        url: finalUrl,
        suggestedName: initial.suggestedName || suggestWebSiteName(finalUrl),
      };
    }

    return {
      ok: false,
      needsPlatform: false,
      reason: `短链接未能解析出有效直播间（落地点：${finalUrl.slice(0, 48)}），请直接粘贴直播间地址或房间号`,
    };
  } catch {
    return {
      ok: false,
      needsPlatform: false,
      reason: '短链接解析超时或网络异常，可直接粘贴直播间链接或选择平台输入房间号',
    };
  } finally {
    clearTimeout(timeout);
  }
}

  ipcMain.handle(
    'livehub:resolve-live-input',
    async (_event, rawInput: string, fallbackPlatform?: ChannelPlatform) =>
      resolveShortLiveInput(rawInput, fallbackPlatform)
  );

  ipcMain.handle('livehub:resolve-stream', async (_event, req: DirectStreamRequest) => {
    const liveSession = session.fromPartition(LIVEHUB_PARTITION);
    const result = await resolveDirectStream(req, liveSession);
    if (result.ok) {
      registerStreamHost(result.flvUrl, result.referer);
      registerStreamHost(result.hlsUrl, result.referer);
    }
    return result;
  });

  ipcMain.handle(
    'livehub:check-live-statuses',
    async (_event, items: LiveStatusCheckItem[]) => checkLiveStatuses(items)
  );

  ipcMain.handle(
    'livehub:start-danmaku',
    async (
      _event,
      slotIndex: number,
      platform: PlatformId,
      roomId: string,
      forceReconnect?: boolean
    ) => {
      return danmakuManager.startSlot(slotIndex, platform, roomId, Boolean(forceReconnect));
    }
  );

  ipcMain.handle('livehub:stop-danmaku', (_event, slotIndex: number) => {
    danmakuManager.stopSlot(slotIndex);
  });

  ipcMain.handle('livehub:set-window-theme', (_event, isDark: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setBackgroundColor(isDark ? '#0e1116' : '#f5f5f7');
      mainWindow.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: isDark ? '#f5f5f7' : '#1d1d1f',
        height: 50,
      });
    } catch {
      // Ignore on unsupported platforms
    }
  });

  ipcMain.handle('livehub:copy-screenshot', async (_event, dataUrl: string) => {
    try {
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      if (buf.length === 0) return false;
      const blob = new Blob([buf], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('livehub:get-diagnostics', () => getDiagnostics());
  ipcMain.handle('livehub:clear-diagnostics', () => {
    clearDiagnostics();
  });

  ipcMain.handle('livehub:get-app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userDataPath: app.getPath('userData'),
  }));

  ipcMain.handle('livehub:check-updates', async () => {
    return checkForAppUpdates();
  });

  ipcMain.handle('livehub:download-update', async (_event, url: string, fileName: string) => {
    return downloadUpdateAsset(url, fileName, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('livehub:update-download-progress', progress);
      }
    });
  });

  ipcMain.handle('livehub:cancel-update-download', async () => {
    await cancelActiveUpdateDownload();
  });

  ipcMain.handle('livehub:install-downloaded-update', async (_event, filePath: string) => {
    return installDownloadedUpdate(filePath, () => {
      void shutdownAndExit();
    });
  });

  ipcMain.handle('livehub:open-external-url', async (_event, url: string) => {
    return openSafeExternalUrl(url);
  });

  createMainWindow(initialState);
  createTray();
  recordDiagnostic(
    'info',
    'system',
    `YourOwn Live 已启动 (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(lastSavedState ?? initialState);
    }
  });
});

app.on('before-quit', () => {
  if (!isQuitting) {
    void shutdownAndExit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void shutdownAndExit();
  }
});
