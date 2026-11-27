import { contextBridge, ipcRenderer } from 'electron';
import type {
  AuthStatusMap,
  ChannelPlatform,
  DanmakuMessage,
  DanmakuStatusEvent,
  DiagnosticLogEntry,
  DirectStreamRequest,
  LiveHubAPI,
  LiveStatusCheckItem,
  PersistedState,
  PlatformId,
  UpdateDownloadOptions,
  UpdateDownloadProgress,
} from '../shared/types';

const api: LiveHubAPI = {
  loadState: () => ipcRenderer.invoke('livehub:load-state'),
  saveState: (state: PersistedState) => ipcRenderer.invoke('livehub:save-state', state),
  setAlwaysOnTop: (flag: boolean) => ipcRenderer.invoke('livehub:set-always-on-top', flag),
  setWindowFullScreen: (flag: boolean) =>
    ipcRenderer.invoke('livehub:set-window-fullscreen', flag),
  toggleBossHide: () => ipcRenderer.invoke('livehub:toggle-boss-hide'),
  setBossKeyShortcut: (shortcut: string) =>
    ipcRenderer.invoke('livehub:set-boss-key', shortcut),
  openPlatformLogin: (platform: PlatformId) =>
    ipcRenderer.invoke('livehub:open-login', platform),
  getAuthStatus: () => ipcRenderer.invoke('livehub:get-auth-status'),
  clearPlatformCookies: (platform?: PlatformId) =>
    ipcRenderer.invoke('livehub:clear-cookies', platform),
  getWebviewPreloadPath: () => ipcRenderer.invoke('livehub:get-webview-preload'),
  wakeWebview: (webContentsId: number, width?: number, height?: number) =>
    ipcRenderer.invoke('livehub:wake-webview', webContentsId, width, height),
  registerFreeWebContents: (webContentsId: number) =>
    ipcRenderer.invoke('livehub:register-free-web', webContentsId),
  resolveLiveInput: (rawInput: string, fallbackPlatform?: ChannelPlatform) =>
    ipcRenderer.invoke('livehub:resolve-live-input', rawInput, fallbackPlatform),
  resolveStream: (req: DirectStreamRequest) =>
    ipcRenderer.invoke('livehub:resolve-stream', req),
  checkLiveStatuses: (items: LiveStatusCheckItem[]) =>
    ipcRenderer.invoke('livehub:check-live-statuses', items),
  startDanmaku: (
    slotIndex: number,
    platform: PlatformId,
    roomId: string,
    forceReconnect?: boolean
  ) => ipcRenderer.invoke('livehub:start-danmaku', slotIndex, platform, roomId, forceReconnect),
  stopDanmaku: (slotIndex: number) => ipcRenderer.invoke('livehub:stop-danmaku', slotIndex),
  sendDanmaku: (platform: PlatformId, roomId: string, text: string) =>
    ipcRenderer.invoke('livehub:send-danmaku', platform, roomId, text),
  setWindowTheme: (isDark: boolean) => ipcRenderer.invoke('livehub:set-window-theme', isDark),
  copyScreenshot: (dataUrl: string) => ipcRenderer.invoke('livehub:copy-screenshot', dataUrl),
  getDiagnostics: () => ipcRenderer.invoke('livehub:get-diagnostics'),
  clearDiagnostics: () => ipcRenderer.invoke('livehub:clear-diagnostics'),
  getAppInfo: () => ipcRenderer.invoke('livehub:get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('livehub:check-updates'),
  downloadUpdate: (url: string, fileName: string, options?: UpdateDownloadOptions) =>
    ipcRenderer.invoke('livehub:download-update', url, fileName, options),
  cancelUpdateDownload: () => ipcRenderer.invoke('livehub:cancel-update-download'),
  installDownloadedUpdate: (filePath: string) =>
    ipcRenderer.invoke('livehub:install-downloaded-update', filePath),
  openExternalUrl: (url: string) => ipcRenderer.invoke('livehub:open-external-url', url),
  onBossKeyTriggered: (callback: (hidden: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, hidden: boolean) => {
      callback(hidden);
    };
    ipcRenderer.on('livehub:boss-toggled', listener);
    return () => {
      ipcRenderer.removeListener('livehub:boss-toggled', listener);
    };
  },
  onAuthStatusChanged: (
    callback: (payload: { status: AuthStatusMap; changedPlatform?: PlatformId }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { status: AuthStatusMap; changedPlatform?: PlatformId }
    ) => {
      callback(payload);
    };
    ipcRenderer.on('livehub:auth-changed', listener);
    return () => {
      ipcRenderer.removeListener('livehub:auth-changed', listener);
    };
  },
  onDanmakuBatch: (callback: (batch: DanmakuMessage[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, batch: DanmakuMessage[]) => {
      callback(batch);
    };
    ipcRenderer.on('livehub:danmaku-batch', listener);
    return () => {
      ipcRenderer.removeListener('livehub:danmaku-batch', listener);
    };
  },
  onDanmakuStatus: (callback: (ev: DanmakuStatusEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ev: DanmakuStatusEvent) => {
      callback(ev);
    };
    ipcRenderer.on('livehub:danmaku-status', listener);
    return () => {
      ipcRenderer.removeListener('livehub:danmaku-status', listener);
    };
  },
  onDiagnosticLog: (callback: (entry: DiagnosticLogEntry) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: DiagnosticLogEntry) => {
      callback(entry);
    };
    ipcRenderer.on('livehub:diagnostic-log', listener);
    return () => {
      ipcRenderer.removeListener('livehub:diagnostic-log', listener);
    };
  },
  onTrayAction: (callback: (action: 'toggle-mute' | 'open-settings') => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      action: 'toggle-mute' | 'open-settings'
    ) => {
      callback(action);
    };
    ipcRenderer.on('livehub:tray-action', listener);
    return () => {
      ipcRenderer.removeListener('livehub:tray-action', listener);
    };
  },
  onBeforeWindowClose: (callback: () => void) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on('livehub:before-close', listener);
    return () => {
      ipcRenderer.removeListener('livehub:before-close', listener);
    };
  },
  onWindowFullScreenChanged: (callback: (isFullScreen: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) => {
      callback(isFullScreen);
    };
    ipcRenderer.on('livehub:fullscreen-changed', listener);
    return () => {
      ipcRenderer.removeListener('livehub:fullscreen-changed', listener);
    };
  },
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: UpdateDownloadProgress) => {
      callback(progress);
    };
    ipcRenderer.on('livehub:update-download-progress', listener);
    return () => {
      ipcRenderer.removeListener('livehub:update-download-progress', listener);
    };
  },
};

contextBridge.exposeInMainWorld('livehub', api);
