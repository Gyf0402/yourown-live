import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpLeft,
  ExternalLink,
  Globe,
  GripVertical,
  Headphones,
  KeyRound,
  Maximize2,
  Minimize2,
  Monitor,
  RefreshCw,
  SlidersHorizontal,
  Smartphone,
  Volume2,
  VolumeX,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  PLATFORM_LIST,
  PLATFORMS,
  QUICK_WEB_PRESETS,
  detectPlatformFromUrl,
  formatWebUrlLabel,
  getChannelPlatformMeta,
  isLivePlatform,
  normalizeWebUrl,
  parseLiveInput,
} from '../../shared/platforms';
import type {
  AuthStatusMap,
  Channel,
  ChannelPlatform,
  DanmakuArea,
  DanmakuMode,
  DanmakuStatusEvent,
  DirectStreamResult,
  PaneSlot,
  PaneViewMode,
  PlatformId,
  StreamOptionsInfo,
  VideoFitMode,
  WebUserAgentMode,
  WebviewPurifyConfig,
} from '../../shared/types';
import type { WebviewElement } from '../env';
import { DirectPlayer } from './DirectPlayer';

const WEB_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0';

const WEB_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';

// React 19 drops boolean `allowpopups={true}` on Electron <webview> (not a standard HTML boolean attr),
// which silently blocks all `target="_blank"` & `window.open()` clicks (like Bilibili video cards).
// Passing string `'true'` ensures the DOM attribute is emitted before Chromium attaches the guest view.
const WEBVIEW_ALLOW_POPUPS = { allowpopups: 'true' } as unknown as { allowpopups: boolean };

const FREE_WEB_POLISH_CSS = `
  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.36); border-radius: 99px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.56); }
`;

// Lightweight, non-intrusive HD preference helper for Douyin / Bilibili video web pages:
// scopes strictly to the currently active visible video player, wakes lazy clarity menus if needed,
// and upgrades default blurry "智能 / 540P / 720P" to the highest free unlocked tier (e.g. 1080P)
// once per session while skipping VIP/login-locked tiers and never fighting manual user changes.
const FREE_WEB_HD_SCRIPT = `(() => {
  try {
    const host = (location.hostname || '').toLowerCase();
    const scoreLabel = (txt) => {
      if (!txt) return -1;
      if (/vip|会员|大会员|登录|专享|限免|付费|扫码/i.test(txt)) return -1;
      if (/4k|2160/i.test(txt)) return 500;
      if (/2k|1440/i.test(txt)) return 400;
      if (/1080.*60|60.*1080/i.test(txt)) return 350;
      if (/1080|原画|蓝光/i.test(txt)) return 300;
      if (/720.*60|60.*720/i.test(txt)) return 220;
      if (/720|超清/i.test(txt)) return 200;
      if (/高清/i.test(txt)) return 150;
      if (/540|480|360|标清|流畅|极速|智能|自动/i.test(txt)) return 50;
      return -1;
    };

    const pickBestUnlocked = (items, minScore) => {
      let bestEl = null;
      let bestScore = minScore;
      for (const item of items) {
        const cls = String(item.className || '').toLowerCase();
        if (cls.includes('disabled') || cls.includes('lock') || cls.includes('vip') || cls.includes('login')) continue;
        if (item.querySelector && item.querySelector('.bpx-player-ctrl-quality-badge-bigvip, .bpx-player-ctrl-quality-badge-login')) continue;
        const txt = (item.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!txt || txt.length > 24) continue;
        const sc = scoreLabel(txt);
        if (sc > bestScore) {
          bestScore = sc;
          bestEl = item;
        }
      }
      return bestEl && bestScore >= 200 ? bestEl : null;
    };

    if (host.includes('douyin.com') && !host.startsWith('live.')) {
      if (window.__livehubDouyinHdApplied) return;
      const activeScope =
        document.querySelector('[data-e2e="feed-active-video"]') ||
        Array.from(document.querySelectorAll('video'))
          .find((v) => !v.paused && v.readyState >= 2 && v.offsetParent !== null)
          ?.closest('.xgplayer, [data-e2e="feed-video"], [class*="player"]') ||
        document;
      const clarityRoot =
        activeScope.querySelector('.xgplayer-clarity, [data-e2e="video-player-clarity"], .gear') ||
        document.querySelector('[data-e2e="feed-active-video"] .gear');
      if (!clarityRoot) return;
      const btnText = (clarityRoot.querySelector('.btn, .gear-btn, span')?.textContent || '').trim();
      const curScore = scoreLabel(btnText);
      if (curScore >= 300) {
        window.__livehubDouyinHdApplied = true;
        return;
      }
      const tryPick = () => {
        const items = Array.from(clarityRoot.querySelectorAll('.item, li, [role="menuitem"], .virtual > div'));
        const bestEl = pickBestUnlocked(items, Math.max(curScore, 100));
        if (bestEl) {
          bestEl.click();
          window.__livehubDouyinHdApplied = true;
          return true;
        }
        return false;
      };
      if (!tryPick()) {
        clarityRoot.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        clarityRoot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        setTimeout(() => {
          tryPick();
          clarityRoot.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        }, 120);
      }
    } else if (host.includes('bilibili.com') && location.pathname.startsWith('/video/')) {
      const key = location.pathname;
      if (window.__livehubBiliHdPath === key) return;
      const curEl = document.querySelector('.bpx-player-ctrl-quality-result');
      const curScore = scoreLabel((curEl?.textContent || '').trim());
      if (curScore >= 300) {
        window.__livehubBiliHdPath = key;
        return;
      }
      const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-quality-menu-item'));
      const bestEl = pickBestUnlocked(items, Math.max(curScore, 100));
      if (bestEl) {
        bestEl.click();
        window.__livehubBiliHdPath = key;
      }
    }
  } catch {}
})();`;

function adaptUrlForUaMode(
  rawUrl: string,
  targetMode: WebUserAgentMode,
  fallbackUrl?: string | null
): string {
  if (!rawUrl) return fallbackUrl || '';
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (targetMode === 'desktop') {
      if (host === 'm.bilibili.com') {
        parsed.hostname = 'www.bilibili.com';
        return parsed.toString();
      }
      if (host === 'm.weibo.cn' || host === 'm.weibo.com') {
        parsed.hostname = 'weibo.com';
        return parsed.toString();
      }
      if (host === 'm.douyin.com' || host === 'iesdouyin.com') {
        parsed.hostname = 'www.douyin.com';
        return parsed.toString();
      }
      if (host === 'm.xiaohongshu.com') {
        parsed.hostname = 'www.xiaohongshu.com';
        return parsed.toString();
      }
      if (host === 'm.zhihu.com') {
        parsed.hostname = 'www.zhihu.com';
        return parsed.toString();
      }
      if (host === 'm.hupu.com') {
        parsed.hostname = 'www.hupu.com';
        return parsed.toString();
      }
      if (host === 'm.youtube.com') {
        parsed.hostname = 'www.youtube.com';
        return parsed.toString();
      }
      if (host.startsWith('m.') && fallbackUrl) {
        try {
          const fb = new URL(fallbackUrl);
          const fbHost = fb.hostname.toLowerCase();
          const bareMobile = host.slice(2);
          if (fbHost === bareMobile || fbHost === `www.${bareMobile}`) {
            parsed.hostname = fb.hostname;
            return parsed.toString();
          }
        } catch {
          // Ignore malformed fallback URL
        }
      }
    } else {
      if ((host === 'weibo.com' || host === 'www.weibo.com') && (parsed.pathname === '/' || parsed.pathname === '')) {
        parsed.hostname = 'm.weibo.cn';
        return parsed.toString();
      }
      if (host === 'www.bilibili.com' && (parsed.pathname === '/' || parsed.pathname === '')) {
        parsed.hostname = 'm.bilibili.com';
        return parsed.toString();
      }
    }
  } catch {
    // Keep rawUrl
  }
  return rawUrl;
}

interface LivePaneProps {
  pane: PaneSlot;
  isActive: boolean;
  isSolo: boolean;
  isMaximized: boolean;
  canMaximize: boolean;
  isHiddenByMaximize: boolean;
  isObscured?: boolean;
  bossHidden?: boolean;
  isPlayerFullscreen: boolean;
  effectiveMuted: boolean;
  isPlatformLoggedIn: boolean;
  platformReloadEpoch: number;
  authStatus: AuthStatusMap;
  reloadEpochs: Record<PlatformId, number>;
  slotReloadTick: number;
  channels: Channel[];
  webviewPreloadPath: string;
  autoHighestQuality: boolean;
  hideGiftEffects: boolean;
  danmakuEnabled: boolean;
  danmakuArea: DanmakuArea;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuSpeed: number;
  danmakuMode: DanmakuMode;
  danmakuBlockKeywords: string[];
  onChangeDanmakuArea: (area: DanmakuArea) => void;
  onChangeDanmakuOpacity: (opacity: number) => void;
  onChangeDanmakuFontSize: (size: number) => void;
  onChangeDanmakuSpeed: (speed: number) => void;
  onChangeDanmakuMode: (mode: DanmakuMode) => void;
  onChangeDanmakuBlockKeywords: (keywords: string[]) => void;
  onUpdatePanePrefs: (
    slotIndex: number,
    patch: Partial<
      Pick<
        PaneSlot,
        | 'volume'
        | 'fitMode'
        | 'preferredQualityId'
        | 'preferredLineId'
        | 'danmakuEnabled'
        | 'webZoom'
        | 'webUserAgentMode'
      >
    >
  ) => void;
  onToggleMaximize: (slotIndex: number) => void;
  onToggleFullscreen: (slotIndex: number) => void;
  onWebviewHtmlFullscreenChange: (slotIndex: number, entering: boolean) => void;
  onDetectedCategory?: (channelId: string, category: string, title?: string, anchorName?: string) => void;
  onSelectPane: (slotIndex: number) => void;
  onLoadUrlInPane: (
    slotIndex: number,
    url: string,
    title?: string,
    channelId?: string | null,
    explicitPlatform?: ChannelPlatform | null
  ) => void;
  onLoadChannelInPane: (slotIndex: number, channel: Channel) => void;
  onToggleMute: (slotIndex: number) => void;
  onToggleSolo: (slotIndex: number) => void;
  onToggleMode: (slotIndex: number, mode: PaneViewMode) => void;
  onUpdateTitle: (slotIndex: number, title: string) => void;
  onClearPane: (slotIndex: number) => void;
  onSwapPanes: (fromSlot: number, toSlot: number) => void;
  onLoginPlatform: (platform: PlatformId) => void;
}

export const LivePane = memo(function LivePane({
  pane,
  isActive,
  isSolo,
  isMaximized,
  canMaximize,
  isHiddenByMaximize,
  isObscured = false,
  bossHidden = false,
  isPlayerFullscreen,
  effectiveMuted,
  isPlatformLoggedIn,
  platformReloadEpoch,
  authStatus,
  reloadEpochs,
  slotReloadTick,
  channels,
  webviewPreloadPath,
  autoHighestQuality,
  hideGiftEffects,
  danmakuEnabled,
  danmakuArea,
  danmakuOpacity,
  danmakuFontSize,
  danmakuSpeed,
  danmakuMode,
  danmakuBlockKeywords,
  onChangeDanmakuArea,
  onChangeDanmakuOpacity,
  onChangeDanmakuFontSize,
  onChangeDanmakuSpeed,
  onChangeDanmakuMode,
  onChangeDanmakuBlockKeywords,
  onUpdatePanePrefs,
  onToggleMaximize,
  onToggleFullscreen,
  onWebviewHtmlFullscreenChange,
  onDetectedCategory,
  onSelectPane,
  onLoadUrlInPane,
  onLoadChannelInPane,
  onToggleMute,
  onToggleSolo,
  onToggleMode,
  onUpdateTitle,
  onClearPane,
  onSwapPanes,
  onLoginPlatform,
}: LivePaneProps) {
  const paneWrapperRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [domReady, setDomReady] = useState(false);
  const [isLoading, setIsLoading] = useState(Boolean(pane.url));
  const [mountReady, setMountReady] = useState(pane.slotIndex === 0);
  const [dragOver, setDragOver] = useState(false);
  const [quickInput, setQuickInput] = useState('');
  const [quickPendingRoomId, setQuickPendingRoomId] = useState<string | null>(null);
  const [quickResolving, setQuickResolving] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [webUaResume, setWebUaResume] = useState<{ baseUrl: string; targetUrl: string } | null>(null);
  const [webCurrentUrl, setWebCurrentUrl] = useState(pane.url || '');
  const [webAddressInput, setWebAddressInput] = useState(pane.url || '');
  const [webAddressFocused, setWebAddressFocused] = useState(false);
  const [webCanGoBack, setWebCanGoBack] = useState(false);
  const [webCanGoForward, setWebCanGoForward] = useState(false);
  const [webLoadError, setWebLoadError] = useState<{ code: number; desc: string; url: string } | null>(null);
  const webAddressFocusedRef = useRef(false);
  webAddressFocusedRef.current = webAddressFocused;
  const lastAppliedZoomRef = useRef<number | null>(null);
  const [streamOptions, setStreamOptions] = useState<StreamOptionsInfo>({
    qualities: [],
    lines: [],
  });
  const [probing, setProbing] = useState(false);
  const [paneHint, setPaneHint] = useState<string | null>(null);
  const [directStream, setDirectStream] = useState<DirectStreamResult | null>(null);
  const [directReloadTick, setDirectReloadTick] = useState(0);
  const [directStreamSeq, setDirectStreamSeq] = useState(0);
  const silentReconnectRef = useRef(false);
  const [directStats, setDirectStats] = useState<{
    protocol: 'FLV' | 'HLS';
    latencySec: number | null;
    resolution?: string;
  } | null>(null);
  const [directPlayError, setDirectPlayError] = useState<string | null>(null);
  const [danmakuStatus, setDanmakuStatus] = useState<DanmakuStatusEvent | null>(null);
  const [hiddenSuspended, setHiddenSuspended] = useState(false);
  const hiddenSuspendedRef = useRef(false);
  const autoRetryCountRef = useRef(0);
  const recentFailTimestampsRef = useRef<number[]>([]);
  const triedLinesRef = useRef<Set<string>>(new Set());
  const stableLineIdRef = useRef<string | null>(null);
  const playingSinceRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const pendingQualityRef = useRef<{ id: string; label: string } | null>(null);
  const onUpdateTitleRef = useRef(onUpdateTitle);
  onUpdateTitleRef.current = onUpdateTitle;
  const onDetectedCategoryRef = useRef(onDetectedCategory);
  onDetectedCategoryRef.current = onDetectedCategory;
  const onWebviewHtmlFullscreenChangeRef = useRef(onWebviewHtmlFullscreenChange);
  onWebviewHtmlFullscreenChangeRef.current = onWebviewHtmlFullscreenChange;
  const lastEpochRef = useRef(platformReloadEpoch);
  const lastSlotReloadRef = useRef(slotReloadTick);

  const directQualityId = pane.preferredQualityId;
  const directLineId = pane.preferredLineId;
  const localDanmakuOn = pane.danmakuEnabled ?? danmakuEnabled;
  const paneVolume = pane.volume ?? 1;
  const paneFitMode: VideoFitMode = pane.fitMode ?? 'contain';
  const webUaMode: WebUserAgentMode = pane.webUserAgentMode ?? 'desktop';
  const webZoomSetting = pane.webZoom ?? 'auto';
  const isWebPane = Boolean(pane.url && pane.platform === 'web');

  const platformMeta = pane.platform ? getChannelPlatformMeta(pane.platform) : null;

  const parsedTarget = useMemo(() => {
    if (!pane.url || isWebPane) return null;
    const parsed = parseLiveInput(pane.url, pane.platform ?? undefined);
    return parsed.ok && isLivePlatform(parsed.platform)
      ? { platform: parsed.platform, roomId: parsed.roomId }
      : null;
  }, [pane.url, pane.platform, isWebPane]);

  const useDirectStream = Boolean(
    pane.url &&
      !isWebPane &&
      pane.mode === 'pure' &&
      parsedTarget &&
      parsedTarget.roomId !== 'home' &&
      !pane.url.includes('/user/') &&
      typeof window !== 'undefined' &&
      typeof window.livehub?.resolveStream === 'function'
  );

  const webCookiePlatform = useMemo(() => {
    if (!isWebPane) return null;
    return detectPlatformFromUrl(webCurrentUrl || pane.url || '');
  }, [isWebPane, webCurrentUrl, pane.url]);

  const effectivePlatformLoggedIn = isWebPane
    ? webCookiePlatform
      ? Boolean(authStatus[webCookiePlatform]?.loggedIn)
      : true
    : isPlatformLoggedIn;

  const effectivePlatformReloadEpoch = isWebPane
    ? webCookiePlatform
      ? reloadEpochs[webCookiePlatform] ?? 0
      : 0
    : platformReloadEpoch;

  const effectiveWebZoom = useMemo(() => {
    if (!isWebPane) return 1;
    if (typeof webZoomSetting === 'number' && Number.isFinite(webZoomSetting)) {
      return Math.max(0.35, Math.min(1.5, Math.round(webZoomSetting * 20) / 20));
    }
    const w = paneWidth;
    if (w <= 0) return 1;
    if (webUaMode === 'mobile') {
      if (w >= 390) return 1;
      return Math.max(0.65, Math.round((w / 390) * 20) / 20);
    }
    // Balance layout fit and text/video crispness:
    // - Fluid sites (Douyin 720px, Xiaohongshu 780px) stay at 100% native pixels in typical split panes.
    // - Wide fixed desktop sites (Bilibili / Weibo) target 980px with a 65% readability floor so Chinese
    //   text never shrinks to blurry 5-7px (users can still manually zoom down to 35% or switch to Mobile).
    const activeUrl = (
      webCurrentUrl && /^https?:/i.test(webCurrentUrl) ? webCurrentUrl : pane.url || ''
    ).toLowerCase();
    const isDouyinMainSite =
      activeUrl.includes('douyin.com') && !activeUrl.includes('live.douyin.com');
    const isXhsSite = activeUrl.includes('xiaohongshu.com');
    const desktopTargetW = isDouyinMainSite ? 720 : isXhsSite ? 780 : 980;
    if (w >= desktopTargetW) return 1;
    return Math.max(0.65, Math.min(1, Math.round((w / desktopTargetW) * 20) / 20));
  }, [isWebPane, webZoomSetting, webUaMode, paneWidth, webCurrentUrl, pane.url]);

  const effectiveWebZoomRef = useRef(effectiveWebZoom);
  effectiveWebZoomRef.current = effectiveWebZoom;
  const effectiveMutedRef = useRef(effectiveMuted);
  effectiveMutedRef.current = effectiveMuted;
  const autoHighestQualityRef = useRef(autoHighestQuality);
  autoHighestQualityRef.current = autoHighestQuality;

  // Observe pane container width (rAF-throttled) for responsive toolbar & adaptive webpage zoom
  useEffect(() => {
    const node = paneWrapperRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let rafId: number | null = null;
    const updateWidth = () => {
      rafId = null;
      const nextW = Math.round(node.clientWidth);
      // Ignore 0px when this pane is hidden via display:none during another pane's maximize
      if (nextW <= 0) return;
      setPaneWidth((cur) => (cur === 0 || Math.abs(cur - nextW) >= 4 ? nextW : cur));
    };
    updateWidth();
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(updateWidth);
    });
    ro.observe(node);
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const showTempHint = useCallback((msg: string, durationMs = 2600) => {
    setPaneHint(msg);
    window.setTimeout(() => {
      setPaneHint((cur) => (cur === msg ? null : cur));
    }, durationMs);
  }, []);

  // Stagger initial multi-pane webview mounts slightly to avoid cold-start CPU/network spikes
  useEffect(() => {
    if (mountReady) return;
    const timer = window.setTimeout(() => setMountReady(true), pane.slotIndex * 260);
    return () => window.clearTimeout(timer);
  }, [mountReady, pane.slotIndex]);

  // Reset transient state when URL changes
  useEffect(() => {
    setDomReady(false);
    setIsLoading(Boolean(pane.url));
    setProbing(false);
    setPaneHint(null);
    setWebUaResume(null);
    setWebCurrentUrl(pane.url || '');
    setWebAddressInput(pane.url || '');
    setWebAddressFocused(false);
    setWebCanGoBack(false);
    setWebCanGoForward(false);
    setWebLoadError(null);
    lastAppliedZoomRef.current = null;
    setStreamOptions({ qualities: [], lines: [] });
    setDirectStream(null);
    setDirectStats(null);
    setDirectPlayError(null);
    setDanmakuStatus(null);
    hiddenSuspendedRef.current = false;
    setHiddenSuspended(false);
    autoRetryCountRef.current = 0;
    recentFailTimestampsRef.current = [];
    triedLinesRef.current = new Set();
    stableLineIdRef.current = null;
    playingSinceRef.current = null;
    silentReconnectRef.current = false;
    pendingQualityRef.current = null;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [pane.url]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  // Respond to keyboard-triggered slot reload
  useEffect(() => {
    if (slotReloadTick === lastSlotReloadRef.current) return;
    lastSlotReloadRef.current = slotReloadTick;
    if (!pane.url) return;
    if (useDirectStream) {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      recentFailTimestampsRef.current = [];
      triedLinesRef.current = new Set();
      stableLineIdRef.current = null;
      playingSinceRef.current = null;
      silentReconnectRef.current = false;
      setDirectPlayError(null);
      setDirectReloadTick((n) => n + 1);
    } else if (webviewRef.current) {
      try {
        webviewRef.current.reload();
      } catch {
        // Ignore
      }
    }
  }, [slotReloadTick, pane.url, useDirectStream]);

  // Gracefully suspend invisible + muted streams after an 8s grace period (saves 100% bandwidth & decode
  // during long single-pane maximize / fullscreen / boss-key hide while keeping brief switches instant
  // and NEVER cutting audio for unmuted background listening).
  const shouldSuspendHidden = Boolean(
    useDirectStream && isObscured && (effectiveMuted || bossHidden)
  );
  useEffect(() => {
    if (!shouldSuspendHidden) {
      if (hiddenSuspendedRef.current) {
        hiddenSuspendedRef.current = false;
        setHiddenSuspended(false);
        silentReconnectRef.current = true;
        setDirectPlayError(null);
        setDirectReloadTick((n) => n + 1);
      }
      return;
    }
    const timer = window.setTimeout(() => {
      hiddenSuspendedRef.current = true;
      setHiddenSuspended(true);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [shouldSuspendHidden]);

  // Shallow-compare stats updates so LivePane does not re-render when badge text is unchanged
  const handleDirectStats = useCallback(
    (next: { protocol: 'FLV' | 'HLS'; latencySec: number | null; resolution?: string }) => {
      const roundedLatency = next.latencySec !== null ? Math.round(next.latencySec) : null;
      setDirectStats((prev) => {
        if (
          prev &&
          prev.protocol === next.protocol &&
          prev.latencySec === roundedLatency &&
          prev.resolution === next.resolution
        ) {
          return prev;
        }
        return {
          protocol: next.protocol,
          latencySec: roundedLatency,
          resolution: next.resolution,
        };
      });
    },
    []
  );

  // Manage native main-process WebSocket danmaku lifecycle & status for this slot
  // (DanmakuOverlay subscribes directly to batch IPC so danmaku bursts never re-render LivePane!)
  useEffect(() => {
    if (
      !useDirectStream ||
      !localDanmakuOn ||
      !directStream?.ok ||
      !parsedTarget ||
      hiddenSuspended ||
      typeof window.livehub?.startDanmaku !== 'function'
    ) {
      setDanmakuStatus(null);
      if (typeof window.livehub?.stopDanmaku === 'function') {
        void window.livehub.stopDanmaku(pane.slotIndex);
      }
      return;
    }

    const unsubStatus =
      typeof window.livehub.onDanmakuStatus === 'function'
        ? window.livehub.onDanmakuStatus((ev) => {
            if (ev.slotIndex === pane.slotIndex) {
              setDanmakuStatus(ev);
            }
          })
        : () => {};

    void window.livehub.startDanmaku(pane.slotIndex, parsedTarget.platform, parsedTarget.roomId);

    return () => {
      unsubStatus();
      setDanmakuStatus(null);
      void window.livehub.stopDanmaku(pane.slotIndex);
    };
  }, [
    useDirectStream,
    localDanmakuOn,
    directStream?.ok,
    hiddenSuspended,
    parsedTarget?.platform,
    parsedTarget?.roomId,
    pane.slotIndex,
  ]);

  // Background couch auto-recovery: if all initial retries failed due to a temporary network/Wi-Fi drop
  // (while the room is NOT offline), gently re-attempt every 12s so playback recovers hands-free
  useEffect(() => {
    const isErrorState =
      useDirectStream &&
      !isLoading &&
      Boolean(pane.url) &&
      (Boolean(directPlayError) || (directStream !== null && !directStream.ok)) &&
      directStream?.status !== 'offline';
    if (!isErrorState) return;

    const timer = window.setTimeout(() => {
      autoRetryCountRef.current = 0;
      setDirectPlayError(null);
      if (!trySwitchFallbackLine('正在尝试备用线路自动恢复')) {
        setDirectReloadTick((n) => n + 1);
      }
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [useDirectStream, isLoading, pane.url, directPlayError, directStream]);

  // Direct low-latency FLV/HLS stream extraction when in Pure (Direct) mode
  useEffect(() => {
    if (!useDirectStream || !parsedTarget || hiddenSuspendedRef.current) return;
    let cancelled = false;
    const isSilent = silentReconnectRef.current;
    silentReconnectRef.current = false;
    if (!isSilent) {
      setIsLoading(true);
    }
    setDirectPlayError(null);

    const effectiveLineId = directLineId || stableLineIdRef.current || undefined;

    const timer = window.setTimeout(() => {
      void window.livehub
        .resolveStream({
          platform: parsedTarget.platform,
          roomId: parsedTarget.roomId,
          qualityId: directQualityId,
          lineId: effectiveLineId,
          autoHighestQuality,
        })
        .then((res) => {
          if (cancelled) return;
          setDirectStream(res);
          setDirectStreamSeq((s) => s + 1);
          setStreamOptions({ qualities: res.qualities || [], lines: res.lines || [] });
          if (res.anchorName || res.title) {
            const displayTitle = res.anchorName
              ? res.title && res.title !== res.anchorName
                ? `${res.anchorName} · ${res.title}`
                : res.anchorName
              : res.title || '';
            if (displayTitle) {
              onUpdateTitleRef.current(pane.slotIndex, displayTitle);
            }
          }
          if (res.ok && res.category && pane.channelId) {
            onDetectedCategoryRef.current?.(pane.channelId, res.category, res.title, res.anchorName);
          }
          const pendingQ = pendingQualityRef.current;
          pendingQualityRef.current = null;
          const actualActiveQ = (res.qualities || []).find((q) => q.active);
          if (res.ok && pendingQ && actualActiveQ && actualActiveQ.id !== pendingQ.id) {
            onUpdatePanePrefs(pane.slotIndex, { preferredQualityId: undefined });
            showTempHint(
              !isPlatformLoggedIn
                ? `「${pendingQ.label}」受平台限制未能切到，已保持「${actualActiveQ.label}」（请先登录解锁）`
                : `平台限制未能切到「${pendingQ.label}」，已自动保持「${actualActiveQ.label}」（可切「网页」模式尝试）`,
              4600
            );
          } else if (res.ok && !isPlatformLoggedIn && (res.qualities || []).some((q) => q.locked)) {
            const lockedFirst = (res.qualities || []).find((q) => q.locked);
            const pName = PLATFORMS[res.platform]?.shortName || '';
            const curLabel = actualActiveQ?.label || '当前画质';
            showTempHint(
              `${pName}未登录仅限${curLabel}，点「登录解锁蓝光」可解锁${lockedFirst?.label || '更高画质'}`,
              4500
            );
          }
          if (!res.ok) {
            if (res.status !== 'offline' && autoRetryCountRef.current < 3) {
              autoRetryCountRef.current += 1;
              const delayMs = autoRetryCountRef.current * 1200;
              showTempHint(`拉流重试中 (${autoRetryCountRef.current}/3)...`);
              if (retryTimerRef.current !== null) {
                window.clearTimeout(retryTimerRef.current);
              }
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                setDirectReloadTick((n) => n + 1);
              }, delayMs);
              return;
            }
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          if (autoRetryCountRef.current < 3) {
            autoRetryCountRef.current += 1;
            const delayMs = autoRetryCountRef.current * 1200;
            showTempHint(`网络波动，正在重试拉流 (${autoRetryCountRef.current}/3)...`);
            if (retryTimerRef.current !== null) {
              window.clearTimeout(retryTimerRef.current);
            }
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              setDirectReloadTick((n) => n + 1);
            }, delayMs);
            return;
          }
          setDirectStream({
            ok: false,
            platform: parsedTarget.platform,
            roomId: parsedTarget.roomId,
            status: 'error',
            referer: '',
            qualities: [],
            lines: [],
            error: err instanceof Error ? err.message : '抓流请求失败',
          });
          setIsLoading(false);
        });
    }, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    useDirectStream,
    parsedTarget?.platform,
    parsedTarget?.roomId,
    directQualityId,
    directLineId,
    autoHighestQuality,
    directReloadTick,
    platformReloadEpoch,
    pane.slotIndex,
  ]);

  // Attach Electron webview lifecycle & IPC listeners (both live Web mode and Free-Web mode)
  useEffect(() => {
    const el = webviewRef.current;
    if (useDirectStream || !el || !pane.url || !mountReady) return;
    if (!isWebPane && !webviewPreloadPath) return;

    const pendingTimers = new Set<number>();
    const scheduleTimer = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        pendingTimers.delete(id);
        fn();
      }, ms);
      pendingTimers.add(id);
      return id;
    };
    let inHtmlFullscreen = false;

    const syncFreeWebNav = () => {
      if (!isWebPane) return;
      try {
        const nextBack = Boolean(el.canGoBack?.());
        const nextFwd = Boolean(el.canGoForward?.());
        setWebCanGoBack((cur) => (cur === nextBack ? cur : nextBack));
        setWebCanGoForward((cur) => (cur === nextFwd ? cur : nextFwd));
        const curUrl = el.getURL?.();
        if (curUrl) {
          setWebCurrentUrl((cur) => (cur === curUrl ? cur : curUrl));
          if (!webAddressFocusedRef.current) {
            setWebAddressInput((cur) => (cur === curUrl ? cur : curUrl));
          }
        }
      } catch {
        // Ignore transient navigation errors
      }
    };

    const registerFreeWeb = () => {
      if (!isWebPane || typeof window.livehub?.registerFreeWebContents !== 'function') return;
      try {
        const wcId = el.getWebContentsId();
        if (wcId) {
          void window.livehub.registerFreeWebContents(wcId);
        }
      } catch {
        // Not ready yet
      }
    };

    const applyFreeWebAdaptation = () => {
      if (!isWebPane) return;
      const z = effectiveWebZoomRef.current;
      try {
        let actualZoom: number | null = null;
        try {
          actualZoom = el.getZoomFactor();
        } catch {
          actualZoom = null;
        }
        if (actualZoom !== null && Math.abs(actualZoom - z) < 0.005) {
          lastAppliedZoomRef.current = z;
          return;
        }
        el.setZoomFactor(z);
        lastAppliedZoomRef.current = z;
      } catch {
        // Ignore if guest is not attached yet
      }
    };

    const handleStartLoading = () => {
      setIsLoading(true);
      setWebLoadError(null);
      registerFreeWeb();
    };

    const handleStopLoading = () => {
      setIsLoading(false);
      syncFreeWebNav();
    };

    const handleFailLoad = (event: Event) => {
      setIsLoading(false);
      if (!isWebPane) return;
      const failEv = event as CustomEvent & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      };
      // Ignore benign aborted loads (-3, e.g. redirects / SPA route changes) and sub-frame failures
      if (failEv.isMainFrame === false || failEv.errorCode === -3) return;
      setWebLoadError({
        code: failEv.errorCode ?? -1,
        desc: failEv.errorDescription || '页面加载失败',
        url: failEv.validatedURL || pane.url || '',
      });
    };

    const handleFinishLoad = () => {
      setIsLoading(false);
      setWebLoadError(null);
      syncFreeWebNav();
      applyFreeWebAdaptation();
    };

    const tryBoostFreeWebVideoQuality = () => {
      if (!isWebPane || !autoHighestQualityRef.current) return;
      try {
        const href = (el.getURL?.() || pane.url || '').toLowerCase();
        if (!href.includes('douyin.com') && !href.includes('bilibili.com/video/')) return;
        void el.executeJavaScript?.(FREE_WEB_HD_SCRIPT)?.catch(() => {});
      } catch {
        // Ignore if guest is navigating
      }
    };

    const handleDomReady = () => {
      setDomReady(true);
      setIsLoading(false);
      try {
        el.setAudioMuted(effectiveMutedRef.current);
        if (isWebPane) {
          registerFreeWeb();
          applyFreeWebAdaptation();
          syncFreeWebNav();
          void el.insertCSS?.(FREE_WEB_POLISH_CSS)?.catch(() => {});
          scheduleTimer(tryBoostFreeWebVideoQuality, 1600);
        } else {
          const cfg: WebviewPurifyConfig = {
            mode: pane.mode,
            autoHighestQuality,
            hideGiftEffects,
            danmakuEnabled,
          };
          el.send('livehub:config', cfg);
          scheduleTimer(() => {
            try {
              const rect = el.getBoundingClientRect();
              void window.livehub.wakeWebview(el.getWebContentsId(), rect.width, rect.height);
            } catch {
              // Ignore
            }
          }, 1600);
        }
      } catch {
        // Ignore transient webview attach errors
      }
    };

    const handleNavigate = (event: Event) => {
      if (!isWebPane) return;
      const navEv = event as CustomEvent & { url?: string };
      if (navEv.url) {
        const nextUrl = navEv.url;
        setWebCurrentUrl((cur) => (cur === nextUrl ? cur : nextUrl));
        if (!webAddressFocusedRef.current) {
          setWebAddressInput((cur) => (cur === nextUrl ? cur : nextUrl));
        }
      }
      syncFreeWebNav();
      // Re-verify actual Chromium zoom on document navigation (no-op if already matched)
      applyFreeWebAdaptation();
    };

    const handleNavigateInPage = (event: Event) => {
      if (!isWebPane) return;
      const navEv = event as CustomEvent & { url?: string };
      if (navEv.url) {
        const nextUrl = navEv.url;
        setWebCurrentUrl((cur) => (cur === nextUrl ? cur : nextUrl));
        if (!webAddressFocusedRef.current) {
          setWebAddressInput((cur) => (cur === nextUrl ? cur : nextUrl));
        }
      }
      try {
        const nextBack = Boolean(el.canGoBack?.());
        const nextFwd = Boolean(el.canGoForward?.());
        setWebCanGoBack((cur) => (cur === nextBack ? cur : nextBack));
        setWebCanGoForward((cur) => (cur === nextFwd ? cur : nextFwd));
      } catch {
        // Ignore
      }
      scheduleTimer(tryBoostFreeWebVideoQuality, 900);
    };

    const handleMediaPlay = () => {
      setIsLoading(false);
      try {
        el.setAudioMuted(effectiveMutedRef.current);
        if (isWebPane) {
          scheduleTimer(tryBoostFreeWebVideoQuality, 500);
        }
      } catch {
        // Ignore
      }
    };

    const handleEnterHtmlFullscreen = () => {
      inHtmlFullscreen = true;
      onWebviewHtmlFullscreenChangeRef.current(pane.slotIndex, true);
    };

    const handleLeaveHtmlFullscreen = () => {
      inHtmlFullscreen = false;
      onWebviewHtmlFullscreenChangeRef.current(pane.slotIndex, false);
    };

    const handleIpcMessage = (event: Event) => {
      if (isWebPane) return;
      const ipcEvent = event as CustomEvent & { channel?: string; args?: unknown[] };
      if (ipcEvent.channel === 'livehub:meta' && Array.isArray(ipcEvent.args) && ipcEvent.args[0]) {
        const meta = ipcEvent.args[0] as { title?: string; hasVideo?: boolean };
        const cleanMetaTitle = meta.title?.trim() || '';
        const isDouyinPlazaFallback =
          pane.platform === 'douyin' &&
          parsedTarget?.roomId !== 'home' &&
          /^(抖音直播广场|抖音直播|直播广场|抖音-记录美好生活)$/i.test(cleanMetaTitle);
        if (cleanMetaTitle && !isDouyinPlazaFallback) {
          onUpdateTitleRef.current(pane.slotIndex, cleanMetaTitle);
        }
        if (meta.hasVideo) {
          setIsLoading(false);
        }
      } else if (
        ipcEvent.channel === 'livehub:stream-options' &&
        Array.isArray(ipcEvent.args) &&
        ipcEvent.args[0]
      ) {
        const info = ipcEvent.args[0] as StreamOptionsInfo;
        const qualities = Array.isArray(info.qualities) ? info.qualities : [];
        const lines = Array.isArray(info.lines) ? info.lines : [];
        setStreamOptions({ qualities, lines });
        setProbing(false);
        if (qualities.length > 0 || lines.length > 0) {
          setPaneHint(null);
        }
      }
    };

    el.addEventListener('did-start-loading', handleStartLoading);
    el.addEventListener('did-stop-loading', handleStopLoading);
    el.addEventListener('did-finish-load', handleFinishLoad);
    el.addEventListener('did-fail-load', handleFailLoad);
    el.addEventListener('dom-ready', handleDomReady);
    el.addEventListener('did-navigate', handleNavigate);
    el.addEventListener('did-navigate-in-page', handleNavigateInPage);
    el.addEventListener('media-started-playing', handleMediaPlay);
    el.addEventListener('enter-html-full-screen', handleEnterHtmlFullscreen);
    el.addEventListener('leave-html-full-screen', handleLeaveHtmlFullscreen);
    el.addEventListener('ipc-message', handleIpcMessage);

    return () => {
      pendingTimers.forEach((id) => window.clearTimeout(id));
      pendingTimers.clear();
      if (inHtmlFullscreen) {
        onWebviewHtmlFullscreenChangeRef.current(pane.slotIndex, false);
      }
      el.removeEventListener('did-start-loading', handleStartLoading);
      el.removeEventListener('did-stop-loading', handleStopLoading);
      el.removeEventListener('did-finish-load', handleFinishLoad);
      el.removeEventListener('did-fail-load', handleFailLoad);
      el.removeEventListener('dom-ready', handleDomReady);
      el.removeEventListener('did-navigate', handleNavigate);
      el.removeEventListener('did-navigate-in-page', handleNavigateInPage);
      el.removeEventListener('media-started-playing', handleMediaPlay);
      el.removeEventListener('enter-html-full-screen', handleEnterHtmlFullscreen);
      el.removeEventListener('leave-html-full-screen', handleLeaveHtmlFullscreen);
      el.removeEventListener('ipc-message', handleIpcMessage);
    };
  }, [useDirectStream, isWebPane, pane.url, pane.slotIndex, webviewPreloadPath, mountReady, webUaMode]);

  // Keep adaptive/manual zoom factor synced smoothly (debounced during auto-resize to prevent OOPIF thrashing)
  useEffect(() => {
    const el = webviewRef.current;
    if (!isWebPane || !el || !domReady) return;
    let currentActual: number | null = null;
    try {
      currentActual = el.getZoomFactor();
    } catch {
      currentActual = lastAppliedZoomRef.current;
    }
    if (
      currentActual !== null &&
      Math.abs(currentActual - effectiveWebZoom) < 0.005 &&
      lastAppliedZoomRef.current !== null &&
      Math.abs(lastAppliedZoomRef.current - effectiveWebZoom) < 0.005
    ) {
      return;
    }
    const apply = () => {
      try {
        el.setZoomFactor(effectiveWebZoom);
        lastAppliedZoomRef.current = effectiveWebZoom;
      } catch {
        // Ignore if guest is navigating
      }
    };
    if (webZoomSetting === 'auto') {
      const timer = window.setTimeout(apply, 95);
      return () => window.clearTimeout(timer);
    }
    apply();
  }, [isWebPane, effectiveWebZoom, webZoomSetting, domReady]);

  // Keep mute state synced after domReady
  useEffect(() => {
    const el = webviewRef.current;
    if (!el || !domReady) return;
    try {
      el.setAudioMuted(effectiveMuted);
    } catch {
      // Ignore if guest is navigating
    }
  }, [effectiveMuted, domReady]);

  // Keep purification config synced after domReady (live webviews only)
  useEffect(() => {
    const el = webviewRef.current;
    if (isWebPane || !el || !domReady) return;
    try {
      const cfg: WebviewPurifyConfig = {
        mode: pane.mode,
        autoHighestQuality,
        hideGiftEffects,
        danmakuEnabled,
      };
      el.send('livehub:config', cfg);
    } catch {
      // Ignore
    }
  }, [isWebPane, pane.mode, autoHighestQuality, hideGiftEffects, danmakuEnabled, domReady]);

  // Auto-reload webview when platform login status changes or manual refresh triggered
  const lastEpochPlatformRef = useRef<PlatformId | null>(webCookiePlatform);
  useEffect(() => {
    const activePlat = isWebPane ? webCookiePlatform : isLivePlatform(pane.platform) ? pane.platform : null;
    if (lastEpochPlatformRef.current !== activePlat) {
      // Switching to a different site in the address bar updates the baseline without spuriously reloading
      lastEpochPlatformRef.current = activePlat;
      lastEpochRef.current = effectivePlatformReloadEpoch;
      return;
    }
    if (effectivePlatformReloadEpoch === lastEpochRef.current) return;
    lastEpochRef.current = effectivePlatformReloadEpoch;
    const el = webviewRef.current;
    if (el && pane.url && domReady) {
      try {
        el.reload();
      } catch {
        // Ignore
      }
    }
  }, [effectivePlatformReloadEpoch, isWebPane, webCookiePlatform, pane.platform, pane.url, domReady]);

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (quickResolving) return;
    const syncRes = parseLiveInput(quickInput);
    if (syncRes.ok) {
      if (syncRes.platform === 'douyu' && typeof window.livehub?.resolveLiveInput === 'function') {
        setQuickResolving(true);
        setQuickError('正在解析斗鱼真实房间号...');
        try {
          const resolved = await window.livehub.resolveLiveInput(quickInput);
          if (resolved.ok && resolved.platform && resolved.roomId && resolved.url) {
            setQuickError(null);
            setQuickPendingRoomId(null);
            setQuickInput('');
            onLoadUrlInPane(
              pane.slotIndex,
              resolved.url,
              resolved.suggestedName ||
                `${getChannelPlatformMeta(resolved.platform).shortName} ${resolved.roomId}`,
              null,
              resolved.platform
            );
            return;
          }
        } finally {
          setQuickResolving(false);
        }
      }
      setQuickError(null);
      setQuickPendingRoomId(null);
      setQuickInput('');
      onLoadUrlInPane(
        pane.slotIndex,
        syncRes.url,
        syncRes.suggestedName ||
          (syncRes.platform === 'web'
            ? formatWebUrlLabel(syncRes.url)
            : `${getChannelPlatformMeta(syncRes.platform).shortName} ${syncRes.roomId}`),
        null,
        syncRes.platform
      );
      return;
    }

    if (syncRes.needsShortResolve && window.livehub?.resolveLiveInput) {
      setQuickResolving(true);
      setQuickError(syncRes.reason);
      try {
        const resolved = await window.livehub.resolveLiveInput(quickInput);
        if (resolved.ok && resolved.platform && resolved.roomId && resolved.url) {
          setQuickError(null);
          setQuickPendingRoomId(null);
          setQuickInput('');
          onLoadUrlInPane(
            pane.slotIndex,
            resolved.url,
            resolved.suggestedName ||
              (resolved.platform === 'web'
                ? formatWebUrlLabel(resolved.url)
                : `${getChannelPlatformMeta(resolved.platform).shortName} ${resolved.roomId}`),
            null,
            resolved.platform
          );
          return;
        }
        if (resolved.needsPlatform && resolved.roomId) {
          setQuickPendingRoomId(resolved.roomId);
        }
        setQuickError(resolved.reason || '无法识别该链接');
      } finally {
        setQuickResolving(false);
      }
      return;
    }

    if (syncRes.needsPlatform && syncRes.roomId) {
      setQuickPendingRoomId(syncRes.roomId);
      setQuickError(syncRes.reason);
      return;
    }
    setQuickPendingRoomId(null);
    setQuickError(syncRes.reason);
  };

  const handleQuickPickPlatform = async (platform: PlatformId) => {
    if (!quickPendingRoomId || quickResolving) return;
    if (platform === 'douyu' && typeof window.livehub?.resolveLiveInput === 'function') {
      setQuickResolving(true);
      setQuickError('正在解析斗鱼真实房间号...');
      try {
        const resolved = await window.livehub.resolveLiveInput(quickPendingRoomId, 'douyu');
        if (resolved.ok && resolved.platform && resolved.roomId && resolved.url) {
          setQuickError(null);
          setQuickPendingRoomId(null);
          setQuickInput('');
          onLoadUrlInPane(
            pane.slotIndex,
            resolved.url,
            resolved.suggestedName ||
              `${getChannelPlatformMeta(resolved.platform).shortName} ${resolved.roomId}`,
            null,
            resolved.platform
          );
          return;
        }
      } finally {
        setQuickResolving(false);
      }
    }
    const res = parseLiveInput(quickPendingRoomId, platform);
    if (res.ok) {
      setQuickError(null);
      setQuickPendingRoomId(null);
      setQuickInput('');
      onLoadUrlInPane(
        pane.slotIndex,
        res.url,
        `${getChannelPlatformMeta(res.platform).shortName} ${res.roomId}`,
        null,
        res.platform
      );
    }
  };

  const handleReload = () => {
    if (useDirectStream) {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      recentFailTimestampsRef.current = [];
      triedLinesRef.current = new Set();
      stableLineIdRef.current = null;
      playingSinceRef.current = null;
      silentReconnectRef.current = false;
      setDirectPlayError(null);
      setDirectReloadTick((n) => n + 1);
      return;
    }
    const el = webviewRef.current;
    if (el) {
      const retryUrl = isWebPane ? webLoadError?.url || webCurrentUrl || pane.url : null;
      setWebLoadError(null);
      try {
        if (isWebPane && retryUrl && (!domReady || webLoadError)) {
          void el.loadURL(retryUrl).catch(() => {});
        } else {
          el.reload();
        }
      } catch {
        if (retryUrl) {
          try {
            void el.loadURL(retryUrl).catch(() => {});
          } catch {
            // Ignore
          }
        }
      }
    }
  };

  const trySwitchFallbackLine = (customReason?: string): boolean => {
    const lines = streamOptions.lines;
    if (!lines || lines.length <= 1) return false;
    const currentId =
      lines.find((l) => l.active)?.id || directLineId || stableLineIdRef.current || lines[0]?.id;
    const currentIdx = Math.max(
      0,
      lines.findIndex((l) => l.id === currentId)
    );
    if (currentId) triedLinesRef.current.add(currentId);

    // Search circularly from currentIdx + 1 for the next untried line
    let nextLine = null;
    for (let offset = 1; offset < lines.length; offset++) {
      const candidate = lines[(currentIdx + offset) % lines.length];
      if (candidate && !triedLinesRef.current.has(candidate.id)) {
        nextLine = candidate;
        break;
      }
    }

    // If all lines were already tried in this session, wrap around circularly to the next line
    // so line failover never gets permanently stuck on long watching sessions
    if (!nextLine) {
      triedLinesRef.current = new Set(currentId ? [currentId] : []);
      nextLine = lines[(currentIdx + 1) % lines.length] || null;
    }
    if (!nextLine || nextLine.id === currentId) return false;

    triedLinesRef.current.add(nextLine.id);
    stableLineIdRef.current = null;
    playingSinceRef.current = null;
    recentFailTimestampsRef.current = [];
    silentReconnectRef.current = true;
    showTempHint(`${customReason || '当前线路不稳定'}，已自动切换至「${nextLine.label}」...`, 3200);
    if (directLineId === nextLine.id) {
      setDirectReloadTick((n) => n + 1);
    } else {
      onUpdatePanePrefs(pane.slotIndex, { preferredLineId: nextLine.id });
    }
    return true;
  };

  const handleProbeStreamOptions = async () => {
    if (useDirectStream) {
      setDirectReloadTick((n) => n + 1);
      return;
    }
    const el = webviewRef.current;
    if (!el || !domReady) {
      showTempHint('页面加载中，请稍候再试');
      return;
    }
    setProbing(true);
    try {
      const rect = el.getBoundingClientRect();
      await window.livehub.wakeWebview(el.getWebContentsId(), rect.width, rect.height);
      await new Promise((r) => window.setTimeout(r, 150));
      el.send('livehub:probe-options');
    } catch {
      // Ignore
    }
    window.setTimeout(() => {
      setProbing(false);
      setStreamOptions((cur) => {
        if (cur.qualities.length === 0 && cur.lines.length === 0) {
          showTempHint('未探测到菜单（未开播或请切「网页」调）');
        }
        return cur;
      });
    }, 1100);
  };

  const handleSelectQuality = (labelOrId: string) => {
    const chosen = streamOptions.qualities.find((q) => q.id === labelOrId);
    if (chosen?.locked && !isPlatformLoggedIn && isLivePlatform(pane.platform)) {
      showTempHint(`「${chosen.label}」需登录${platformMeta?.shortName || ''}账号后解锁，正在打开登录...`);
      onLoginPlatform(pane.platform);
      return;
    }
    if (useDirectStream) {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      triedLinesRef.current = new Set();
      stableLineIdRef.current = null;
      playingSinceRef.current = null;
      silentReconnectRef.current = false;
      pendingQualityRef.current = chosen
        ? { id: chosen.id, label: chosen.label }
        : { id: labelOrId, label: labelOrId };
      onUpdatePanePrefs(pane.slotIndex, { preferredQualityId: labelOrId });
      if (directQualityId === labelOrId) {
        setDirectReloadTick((n) => n + 1);
      }
      setStreamOptions((prev) => ({
        ...prev,
        qualities: prev.qualities.map((q) => ({ ...q, active: q.id === labelOrId })),
      }));
      return;
    }
    const el = webviewRef.current;
    if (!el || !domReady) return;
    setStreamOptions((prev) => ({
      ...prev,
      qualities: prev.qualities.map((q) => ({ ...q, active: q.id === labelOrId })),
    }));
    try {
      el.send('livehub:select-quality', labelOrId);
    } catch {
      // Ignore
    }
  };

  const handleSelectLine = (labelOrId: string) => {
    if (useDirectStream) {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      triedLinesRef.current = new Set([labelOrId]);
      stableLineIdRef.current = labelOrId;
      playingSinceRef.current = null;
      silentReconnectRef.current = false;
      onUpdatePanePrefs(pane.slotIndex, { preferredLineId: labelOrId });
      setStreamOptions((prev) => ({
        ...prev,
        lines: prev.lines.map((l) => ({ ...l, active: l.id === labelOrId })),
      }));
      return;
    }
    const el = webviewRef.current;
    if (!el || !domReady) return;
    setStreamOptions((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => ({ ...l, active: l.id === labelOrId })),
    }));
    try {
      el.send('livehub:select-line', labelOrId);
    } catch {
      // Ignore
    }
  };

  const activeQualityValue =
    streamOptions.qualities.find((q) => q.active)?.id ??
    streamOptions.qualities[0]?.id ??
    '';
  const activeLineValue =
    streamOptions.lines.find((l) => l.active)?.id ??
    streamOptions.lines[0]?.id ??
    '';

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const fromSlotRaw = e.dataTransfer.getData('application/x-livehub-pane');
    if (fromSlotRaw !== '') {
      const fromSlot = Number(fromSlotRaw);
      if (!Number.isNaN(fromSlot) && fromSlot !== pane.slotIndex) {
        onSwapPanes(fromSlot, pane.slotIndex);
      }
      return;
    }

    const channelRaw = e.dataTransfer.getData('application/x-livehub-channel');
    if (channelRaw) {
      try {
        const ch = JSON.parse(channelRaw) as Channel;
        onLoadChannelInPane(pane.slotIndex, ch);
      } catch {
        // Ignore invalid payload
      }
    }
  };

  const handleWebAddressSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = webAddressInput.trim();
    if (!raw) return;
    const normalized =
      normalizeWebUrl(raw) ?? `https://www.baidu.com/s?wd=${encodeURIComponent(raw)}`;
    setWebCurrentUrl(normalized);
    setWebAddressInput(normalized);
    const el = webviewRef.current;
    if (el && domReady) {
      try {
        void el.loadURL(normalized).catch(() => {});
      } catch {
        // Fallback to reloading slot url
        onLoadUrlInPane(pane.slotIndex, normalized, undefined, pane.channelId, 'web');
      }
    } else {
      onLoadUrlInPane(pane.slotIndex, normalized, undefined, pane.channelId, 'web');
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleWebGoBack = () => {
    const el = webviewRef.current;
    if (el && domReady && el.canGoBack?.()) {
      try {
        el.goBack();
      } catch {
        // Ignore
      }
    }
  };

  const handleWebGoForward = () => {
    const el = webviewRef.current;
    if (el && domReady && el.canGoForward?.()) {
      try {
        el.goForward();
      } catch {
        // Ignore
      }
    }
  };

  const compactWebBar = paneWidth === 0 || paneWidth < 820;
  const ultraCompactWebBar = paneWidth === 0 || paneWidth < 600;
  const microCompactWebBar = paneWidth > 0 && paneWidth < 420;
  const nanoCompactWebBar = paneWidth > 0 && paneWidth < 290;

  const handleStepWebZoom = (delta: number) => {
    const next = Math.max(0.35, Math.min(1.5, Math.round((effectiveWebZoom + delta) * 20) / 20));
    onUpdatePanePrefs(pane.slotIndex, { webZoom: next });
  };

  const handleResetOrCycleWebZoom = () => {
    if (ultraCompactWebBar) {
      // Compact mode (step buttons hidden): cycle auto -> 50% -> 75% -> 100% -> auto
      if (webZoomSetting === 'auto') {
        onUpdatePanePrefs(pane.slotIndex, { webZoom: 0.5 });
      } else if (webZoomSetting < 0.72) {
        onUpdatePanePrefs(pane.slotIndex, { webZoom: 0.75 });
      } else if (webZoomSetting < 0.98) {
        onUpdatePanePrefs(pane.slotIndex, { webZoom: 1 });
      } else {
        onUpdatePanePrefs(pane.slotIndex, { webZoom: 'auto' });
      }
      return;
    }
    onUpdatePanePrefs(pane.slotIndex, { webZoom: webZoomSetting === 'auto' ? 1 : 'auto' });
  };

  const handleToggleWebUaMode = () => {
    const nextMode: WebUserAgentMode = webUaMode === 'desktop' ? 'mobile' : 'desktop';
    const currentHref = webCurrentUrl || pane.url || '';
    const adaptedHref = adaptUrlForUaMode(currentHref, nextMode, pane.url);
    if (adaptedHref && pane.url) {
      setWebUaResume({ baseUrl: pane.url, targetUrl: adaptedHref });
      setWebCurrentUrl(adaptedHref);
      setWebAddressInput(adaptedHref);
    }
    lastAppliedZoomRef.current = null;
    setDomReady(false);
    setIsLoading(true);
    onUpdatePanePrefs(pane.slotIndex, {
      webUserAgentMode: nextMode,
      webZoom: 'auto',
    });
  };

  const handleOpenWebExternal = () => {
    const target = webCurrentUrl || pane.url;
    if (target && typeof window.livehub?.openExternalUrl === 'function') {
      void window.livehub.openExternalUrl(target);
    }
  };

  const resolvedWebSrc =
    pane.url && webUaResume && webUaResume.baseUrl === pane.url
      ? webUaResume.targetUrl
      : pane.url || '';

  const livePlatformForAuth: PlatformId | null = isLivePlatform(pane.platform)
    ? pane.platform
    : webCookiePlatform;

  return (
    <div
      ref={paneWrapperRef}
      className={`pane-wrapper ${isActive ? 'active-pane' : ''} ${!pane.url ? 'empty' : ''} ${
        isWebPane ? 'is-web-pane' : ''
      } ${dragOver ? 'drag-over' : ''} ${isMaximized ? 'is-maximized' : ''} ${
        isHiddenByMaximize ? 'is-hidden-by-max' : ''
      } ${isPlayerFullscreen ? 'is-player-fullscreen' : ''}`}
      onMouseDown={() => onSelectPane(pane.slotIndex)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {isWebPane ? (
        <div
          className={`pane-toolbar web-docked-bar ${compactWebBar ? 'is-compact' : ''} ${
            ultraCompactWebBar ? 'is-ultra-compact' : ''
          } ${microCompactWebBar ? 'is-micro-compact' : ''} ${
            nanoCompactWebBar ? 'is-nano-compact' : ''
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="web-bar-left">
            <div
              className="pane-drag-handle web-drag-handle"
              draggable={!isMaximized}
              onDragStart={(e) => {
                if (isMaximized) return;
                e.dataTransfer.setData('application/x-livehub-pane', String(pane.slotIndex));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDoubleClick={(e) => {
                if (!canMaximize) return;
                e.stopPropagation();
                onToggleMaximize(pane.slotIndex);
              }}
              title={
                canMaximize
                  ? '拖拽与其他分屏互换位置，双击临时放大/还原'
                  : '拖拽与其他分屏互换位置'
              }
            >
              <GripVertical size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              {!ultraCompactWebBar && platformMeta && (
                <span
                  className="platform-badge"
                  style={{ color: platformMeta.color, background: platformMeta.bgTint }}
                >
                  {platformMeta.shortName}
                </span>
              )}
            </div>

            {(!nanoCompactWebBar || webCanGoBack) && (
              <button
                className="pane-btn web-icon-btn"
                onClick={handleWebGoBack}
                disabled={!webCanGoBack}
                title="后退"
              >
                <ArrowLeft size={12} />
              </button>
            )}
            {!microCompactWebBar && (
              <button
                className="pane-btn web-icon-btn"
                onClick={handleWebGoForward}
                disabled={!webCanGoForward}
                title="前进"
              >
                <ArrowRight size={12} />
              </button>
            )}
            <button
              className="pane-btn web-icon-btn"
              onClick={handleReload}
              title="刷新网页 (R)"
            >
              <RefreshCw size={12} className={isLoading ? 'spin-icon' : ''} />
            </button>
          </div>

          <form className="web-address-form" onSubmit={handleWebAddressSubmit}>
            <Globe size={12} className="web-address-icon" />
            <input
              className="web-url-input"
              value={webAddressFocused ? webAddressInput : formatWebUrlLabel(webCurrentUrl || pane.url || '')}
              onFocus={(e) => {
                setWebAddressFocused(true);
                setWebAddressInput(webCurrentUrl || pane.url || '');
                window.setTimeout(() => e.target.select(), 0);
              }}
              onBlur={() => {
                setWebAddressFocused(false);
                setWebAddressInput(webCurrentUrl || pane.url || '');
              }}
              onChange={(e) => setWebAddressInput(e.target.value)}
              placeholder="输入网址或关键词回车跳转..."
              title={webCurrentUrl || pane.url || ''}
            />
          </form>

          <div className="web-bar-right">
            {livePlatformForAuth && !effectivePlatformLoggedIn && !nanoCompactWebBar && (
              <button
                className={`pane-btn login-hint ${compactWebBar ? 'web-icon-btn' : ''}`}
                onClick={() => onLoginPlatform(livePlatformForAuth)}
                title={`点击登录${PLATFORMS[livePlatformForAuth].name}，Cookie 将自动同步至此网页`}
              >
                <KeyRound size={12} />
                {!compactWebBar && <span>登录同步</span>}
              </button>
            )}

            <div className="web-zoom-group">
              {!ultraCompactWebBar && (
                <button
                  className="pane-btn web-icon-btn"
                  onClick={() => handleStepWebZoom(-0.1)}
                  disabled={effectiveWebZoom <= 0.35}
                  title="缩小网页显示比例"
                >
                  <ZoomOut size={12} />
                </button>
              )}
              <button
                className={`pane-btn web-zoom-pill ${webZoomSetting === 'auto' ? 'is-auto' : ''}`}
                onClick={handleResetOrCycleWebZoom}
                title={
                  ultraCompactWebBar
                    ? webZoomSetting === 'auto'
                      ? `当前宽度自适应 (${Math.round(effectiveWebZoom * 100)}%)，点击循环切换 50% / 75% / 100% / 自适应`
                      : `当前手动缩放 ${Math.round(effectiveWebZoom * 100)}%，点击循环切换或恢复自适应`
                    : webZoomSetting === 'auto'
                      ? `当前已开启宽度自适应缩放 (${Math.round(effectiveWebZoom * 100)}%)，点击切换 100%`
                      : `当前手动缩放 ${Math.round(effectiveWebZoom * 100)}%，点击恢复宽度自适应`
                }
              >
                <span>
                  {webZoomSetting === 'auto'
                    ? `${ultraCompactWebBar ? '' : '适配 '}${Math.round(effectiveWebZoom * 100)}%`
                    : `${Math.round(effectiveWebZoom * 100)}%`}
                </span>
              </button>
              {!ultraCompactWebBar && (
                <button
                  className="pane-btn web-icon-btn"
                  onClick={() => handleStepWebZoom(0.1)}
                  disabled={effectiveWebZoom >= 1.5}
                  title="放大网页显示比例"
                >
                  <ZoomIn size={12} />
                </button>
              )}
            </div>

            <button
              className={`pane-btn ${compactWebBar ? 'web-icon-btn' : ''} ${
                webUaMode === 'mobile' ? 'web-ua-mobile' : ''
              }`}
              onClick={handleToggleWebUaMode}
              title={
                webUaMode === 'mobile'
                  ? '当前：手机版排版（适合窄屏刷B站/微博），点击切回桌面版'
                  : '当前：桌面版排版，点击切换手机版以适配窄屏'
              }
            >
              {webUaMode === 'mobile' ? <Smartphone size={12} /> : <Monitor size={12} />}
              {!compactWebBar && <span>{webUaMode === 'mobile' ? '手机' : '桌面'}</span>}
            </button>

            {!microCompactWebBar && (
              <button
                className={`pane-btn ${compactWebBar ? 'web-icon-btn' : ''} ${
                  isSolo ? 'solo-active' : ''
                }`}
                onClick={() => onToggleSolo(pane.slotIndex)}
                title={isSolo ? '取消独听' : `独听此网页（快捷键 ${pane.slotIndex + 1}）`}
              >
                <Headphones size={12} />
                {!compactWebBar && <span>{isSolo ? '独听中' : '独听'}</span>}
              </button>
            )}

            <button
              className={`pane-btn web-icon-btn ${effectiveMuted ? 'muted-active' : ''}`}
              onClick={() => onToggleMute(pane.slotIndex)}
              title={effectiveMuted ? '取消静音 (M)' : '静音此网页 (M)'}
            >
              {effectiveMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>

            {canMaximize && (
              <button
                className={`pane-btn web-icon-btn ${isMaximized ? 'solo-active' : ''}`}
                onClick={() => onToggleMaximize(pane.slotIndex)}
                title={isMaximized ? '还原分屏布局 (Esc)' : '临时单屏放大'}
              >
                {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            )}

            {pane.slotIndex > 0 && !isMaximized && !ultraCompactWebBar && (
              <button
                className="pane-btn web-icon-btn"
                onClick={() => onSwapPanes(pane.slotIndex, 0)}
                title="切为主屏（与 1 号画面互换）"
              >
                <ArrowUpLeft size={12} />
              </button>
            )}

            {!ultraCompactWebBar && (
              <button
                className="pane-btn web-icon-btn"
                onClick={handleOpenWebExternal}
                title="在系统默认浏览器中打开当前网址"
              >
                <ExternalLink size={12} />
              </button>
            )}

            <button
              className="pane-btn web-icon-btn"
              onClick={() => onClearPane(pane.slotIndex)}
              title="关闭此画面"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : (
        <div className={`pane-toolbar ${isSolo || isMaximized ? 'pinned-bar' : ''}`}>
          <div className="pane-toolbar-left">
            <div
              className="pane-drag-handle"
              draggable={!isMaximized}
              onDragStart={(e) => {
                if (isMaximized) return;
                e.dataTransfer.setData('application/x-livehub-pane', String(pane.slotIndex));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDoubleClick={(e) => {
                if (!canMaximize) return;
                e.stopPropagation();
                onToggleMaximize(pane.slotIndex);
              }}
              title={
                canMaximize
                  ? '拖拽互换位置，双击标题栏临时放大/还原分屏'
                  : '拖拽与其他分屏互换位置'
              }
            >
              <GripVertical size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              {platformMeta && (
                <span
                  className="platform-badge"
                  style={{ color: platformMeta.color, background: platformMeta.bgTint }}
                >
                  {platformMeta.shortName}
                </span>
              )}
              <span className="pane-title">
                {pane.url ? pane.title : `画面 ${pane.slotIndex + 1}（空闲）`}
              </span>
            </div>
          </div>

          <div className="pane-toolbar-right" onClick={(e) => e.stopPropagation()}>
            {channels.length > 0 && (
              <select
                className="pane-btn"
                style={{ maxWidth: 112 }}
                value={pane.channelId ?? ''}
                onChange={(e) => {
                  const chosen = channels.find((c) => c.id === e.target.value);
                  if (chosen) onLoadChannelInPane(pane.slotIndex, chosen);
                }}
                title="快速切换收藏主播或网页"
              >
                <option value="" disabled>
                  切换收藏
                </option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    [{getChannelPlatformMeta(ch.platform).shortName}] {ch.name}
                  </option>
                ))}
              </select>
            )}

            {pane.url && (
              <>
                {livePlatformForAuth && !isPlatformLoggedIn && (
                  <button
                    className="pane-btn login-hint"
                    onClick={() => onLoginPlatform(livePlatformForAuth)}
                    title={`当前未登录${PLATFORMS[livePlatformForAuth].name}，点击扫码登录解锁蓝光/原画高画质`}
                  >
                    <KeyRound size={12} />
                    <span>登录解锁蓝光</span>
                  </button>
                )}

                {streamOptions.qualities.length > 0 ? (
                  <select
                    className="pane-btn pane-select"
                    value={activeQualityValue}
                    onChange={(e) => handleSelectQuality(e.target.value)}
                    title="切换直播画质（原画 / 蓝光 / 超清 / 高清）"
                  >
                    {streamOptions.qualities.map((q) => (
                      <option key={q.id} value={q.id}>
                        画质: {q.label}{q.locked ? ' (需登录)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    className="pane-btn"
                    onClick={() => void handleProbeStreamOptions()}
                    title="探测当前播放器画质与线路选项"
                  >
                    <SlidersHorizontal size={12} />
                    <span>{probing ? '探测中...' : '画质/线路'}</span>
                  </button>
                )}

                {streamOptions.lines.length > 0 && (
                  <select
                    className="pane-btn pane-select"
                    value={activeLineValue}
                    onChange={(e) => handleSelectLine(e.target.value)}
                    title="切换 CDN 播放线路"
                  >
                    {streamOptions.lines.map((l) => (
                      <option key={l.id} value={l.id}>
                        线路: {l.label}
                      </option>
                    ))}
                  </select>
                )}

                {(streamOptions.qualities.length > 0 || streamOptions.lines.length > 0) && (
                  <button
                    className="pane-btn"
                    onClick={() => void handleProbeStreamOptions()}
                    title="重新探测画质与线路"
                  >
                    <SlidersHorizontal size={12} />
                  </button>
                )}

                {paneHint && (
                  <span className="pane-btn login-hint" style={{ pointerEvents: 'none' }}>
                    {paneHint}
                  </span>
                )}

                <button
                  className={`pane-btn ${isSolo ? 'solo-active' : ''}`}
                  onClick={() => onToggleSolo(pane.slotIndex)}
                  title={isSolo ? '取消独听' : `独听（快捷键 ${pane.slotIndex + 1}）`}
                >
                  <Headphones size={12} />
                  <span>{isSolo ? '独听中' : '独听'}</span>
                </button>

                <button
                  className={`pane-btn ${effectiveMuted ? 'muted-active' : ''}`}
                  onClick={() => onToggleMute(pane.slotIndex)}
                  title={effectiveMuted ? '取消静音 (M)' : '静音此画面 (M)'}
                >
                  {effectiveMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                </button>

                {useDirectStream && directStats && (
                  <span
                    className="pane-btn direct-badge"
                    title={
                      directStats.resolution
                        ? `极速直连 ${directStats.protocol} · 分辨率 ${directStats.resolution}`
                        : `极速直连 ${directStats.protocol}`
                    }
                  >
                    <Zap size={11} />
                    <span>
                      {directStats.protocol}
                      {directStats.latencySec !== null ? ` ${directStats.latencySec}s` : ''}
                    </span>
                  </span>
                )}

                <button
                  className={`pane-btn ${pane.mode === 'full' ? 'mode-full' : ''}`}
                  onClick={() =>
                    onToggleMode(pane.slotIndex, pane.mode === 'pure' ? 'full' : 'pure')
                  }
                  title="切换极速直连（超低延迟无广告） / 完整网页模式（发弹幕、看重播）"
                >
                  {pane.mode === 'pure' ? <Zap size={12} /> : <Globe size={12} />}
                  <span>{pane.mode === 'pure' ? '直连' : '网页'}</span>
                </button>

                {canMaximize && (
                  <button
                    className={`pane-btn ${isMaximized ? 'solo-active' : ''}`}
                    onClick={() => onToggleMaximize(pane.slotIndex)}
                    title={isMaximized ? '还原分屏布局 (Esc)' : '临时单屏放大（不破坏当前分屏布局）'}
                  >
                    {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                  </button>
                )}

                {pane.slotIndex > 0 && !isMaximized && (
                  <button
                    className="pane-btn"
                    onClick={() => onSwapPanes(pane.slotIndex, 0)}
                    title="切为主屏（与 1 号主画面互换）"
                  >
                    <ArrowUpLeft size={12} />
                  </button>
                )}

                <button className="pane-btn" onClick={handleReload} title="刷新该直播间 (R)">
                  <RefreshCw size={12} />
                </button>

                <button
                  className="pane-btn"
                  onClick={() => onClearPane(pane.slotIndex)}
                  title="关闭此画面"
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {pane.url && useDirectStream ? (
        <div className="direct-stage">
          {directStream?.ok && !directPlayError ? (
            <DirectPlayer
              slotIndex={pane.slotIndex}
              platform={parsedTarget?.platform}
              roomId={parsedTarget?.roomId}
              isPlatformLoggedIn={isPlatformLoggedIn}
              streamKey={parsedTarget ? `${parsedTarget.platform}:${parsedTarget.roomId}` : pane.url || ''}
              flvUrl={directStream.flvUrl}
              hlsUrl={directStream.hlsUrl}
              muted={effectiveMuted}
              volume={paneVolume}
              fitMode={paneFitMode}
              isObscured={isObscured}
              suspended={hiddenSuspended}
              reloadToken={directStreamSeq}
              danmakuEnabled={localDanmakuOn}
              danmakuArea={danmakuArea}
              danmakuOpacity={danmakuOpacity}
              danmakuFontSize={danmakuFontSize}
              danmakuSpeed={danmakuSpeed}
              danmakuMode={danmakuMode}
              danmakuBlockKeywords={danmakuBlockKeywords}
              danmakuStatus={danmakuStatus}
              onLoginPlatform={onLoginPlatform}
              onSwitchToWebMode={() => onToggleMode(pane.slotIndex, 'full')}
              onReconnectDanmaku={() => {
                if (parsedTarget && typeof window.livehub?.startDanmaku === 'function') {
                  void window.livehub.startDanmaku(
                    pane.slotIndex,
                    parsedTarget.platform,
                    parsedTarget.roomId,
                    true
                  );
                }
              }}
              onChangeVolume={(vol) => onUpdatePanePrefs(pane.slotIndex, { volume: vol })}
              onToggleFitMode={() =>
                onUpdatePanePrefs(pane.slotIndex, {
                  fitMode: paneFitMode === 'contain' ? 'cover' : 'contain',
                })
              }
              onToggleDanmaku={() =>
                onUpdatePanePrefs(pane.slotIndex, { danmakuEnabled: !localDanmakuOn })
              }
              onChangeDanmakuArea={onChangeDanmakuArea}
              onChangeDanmakuOpacity={onChangeDanmakuOpacity}
              onChangeDanmakuFontSize={onChangeDanmakuFontSize}
              onChangeDanmakuSpeed={onChangeDanmakuSpeed}
              onChangeDanmakuMode={onChangeDanmakuMode}
              onChangeDanmakuBlockKeywords={onChangeDanmakuBlockKeywords}
              onToggleMute={() => onToggleMute(pane.slotIndex)}
              onReload={handleReload}
              isFullscreen={isPlayerFullscreen}
              onToggleFullscreen={() => onToggleFullscreen(pane.slotIndex)}
              onAutoReconnect={(reason) => {
                if (reason === 'resume-from-pause') {
                  if (retryTimerRef.current !== null) {
                    window.clearTimeout(retryTimerRef.current);
                    retryTimerRef.current = null;
                  }
                  silentReconnectRef.current = true;
                  setDirectPlayError(null);
                  setDirectReloadTick((n) => n + 1);
                  return;
                }
                if (retryTimerRef.current !== null) return;
                playingSinceRef.current = null;
                const now = Date.now();
                // Routine long-playback FLV EOF on a stable line does NOT count as a line failure unless it happens repeatedly
                const isHardDisconnect =
                  reason === 'early-eof' || reason === 'startup-timeout' || reason === 'stall-watchdog';
                recentFailTimestampsRef.current = [
                  ...recentFailTimestampsRef.current.filter((ts) => now - ts < 45000),
                  now,
                ];
                const recentDisconnectCount = recentFailTimestampsRef.current.length;

                // Immediately switch to fallback CDN line if:
                // 1) Current line failed during startup or closed within <6s ('early-eof' / 'startup-timeout'), OR
                // 2) Current line disconnected/stalled >= 2 times within 45s (even if it briefly played a few frames in between), OR
                // 3) Consecutive autoRetryCount >= 2
                if (
                  (reason === 'early-eof' ||
                    reason === 'startup-timeout' ||
                    (isHardDisconnect && recentDisconnectCount >= 2) ||
                    recentDisconnectCount >= 3 ||
                    autoRetryCountRef.current >= 2) &&
                  trySwitchFallbackLine(
                    reason === 'startup-timeout'
                      ? '当前线路响应超时'
                      : reason === 'early-eof'
                        ? '当前线路连接中断'
                        : '当前线路频繁波动'
                  )
                ) {
                  autoRetryCountRef.current = 0;
                  setDirectPlayError(null);
                  return;
                }
                if (autoRetryCountRef.current >= 4) {
                  setDirectPlayError('直播流长时间无响应，正在后台等待自动恢复（也可点击立即重试）');
                  setIsLoading(false);
                  return;
                }
                autoRetryCountRef.current += 1;
                const delayMs = reason === 'flv-eof' ? 250 : Math.min(4500, autoRetryCountRef.current * 900);
                showTempHint(reason === 'flv-eof' ? '连接自动续播中...' : '流连接刷新中，自动续播...');
                retryTimerRef.current = window.setTimeout(() => {
                  retryTimerRef.current = null;
                  silentReconnectRef.current = true;
                  setDirectPlayError(null);
                  setDirectReloadTick((n) => n + 1);
                }, delayMs);
              }}
              onPlaying={() => {
                setIsLoading(false);
                const now = Date.now();
                if (playingSinceRef.current === null) {
                  playingSinceRef.current = now;
                } else if (now - playingSinceRef.current >= 12000) {
                  // Only reset retry & failure counters after >= 12s of genuinely continuous playback!
                  // Never reset on the very first frame, otherwise a flaky line that plays 2s and drops will loop forever.
                  autoRetryCountRef.current = 0;
                  recentFailTimestampsRef.current = [];
                  const currentActiveLine =
                    streamOptions.lines.find((l) => l.active)?.id || directLineId || null;
                  if (currentActiveLine) {
                    stableLineIdRef.current = currentActiveLine;
                  }
                  triedLinesRef.current = new Set();
                }
              }}
              onStats={handleDirectStats}
              onError={(reason) => {
                playingSinceRef.current = null;
                const now = Date.now();
                recentFailTimestampsRef.current = [
                  ...recentFailTimestampsRef.current.filter((ts) => now - ts < 45000),
                  now,
                ];
                if (
                  (autoRetryCountRef.current >= 1 || recentFailTimestampsRef.current.length >= 2) &&
                  trySwitchFallbackLine('当前线路拉流异常')
                ) {
                  autoRetryCountRef.current = 0;
                  setDirectPlayError(null);
                  return;
                }
                if (autoRetryCountRef.current < 3) {
                  autoRetryCountRef.current += 1;
                  const delayMs = autoRetryCountRef.current * 1000;
                  showTempHint('线路波动，自动重连中...');
                  if (retryTimerRef.current !== null) {
                    window.clearTimeout(retryTimerRef.current);
                  }
                  retryTimerRef.current = window.setTimeout(() => {
                    retryTimerRef.current = null;
                    silentReconnectRef.current = true;
                    setDirectReloadTick((n) => n + 1);
                  }, delayMs);
                  return;
                }
                setDirectPlayError(reason);
                setIsLoading(false);
              }}
            />
          ) : (
            !isLoading && (
              <div className="direct-status-wrap">
                <div className="direct-status-card">
                  <div className="pane-empty-title">
                    {directStream?.status === 'offline'
                      ? `${directStream.anchorName ? `${directStream.anchorName} · ` : ''}暂未开播`
                      : '直连拉流暂未成功'}
                  </div>
                  <div className="pane-empty-sub">
                    {directPlayError || directStream?.error || '未能解析到实时流地址'}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button className="primary-btn" onClick={handleReload}>
                      <RefreshCw size={12} />
                      <span>重试直连</span>
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => onToggleMode(pane.slotIndex, 'full')}
                    >
                      <Globe size={12} />
                      <span>切网页模式</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          )}
          {isLoading && (
            <div className="pane-loading-overlay">
              <div
                className="stream-loader-card"
                style={
                  {
                    '--loader-accent': platformMeta?.color || '#007aff',
                  } as React.CSSProperties
                }
              >
                <div className="stream-loader-orb" aria-hidden="true">
                  <span className="stream-loader-ripple r1" />
                  <span className="stream-loader-ripple r2" />
                  <span className="stream-loader-ring" />
                  <span className="stream-loader-core">
                    <Zap size={16} strokeWidth={2.3} />
                  </span>
                </div>
                <div className="stream-loader-body">
                  <div className="stream-loader-title">
                    <span>{platformMeta ? `${platformMeta.shortName} · ` : ''}极速直连拉流中</span>
                    <span className="stream-loader-bars" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="stream-loader-track" aria-hidden="true">
                    <span className="stream-loader-beam" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : isWebPane && pane.url ? (
        <div className="web-pane-stage">
          {mountReady && (
            <webview
              key={`web-${pane.slotIndex}-${pane.url}-${webUaMode}`}
              ref={(node) => {
                webviewRef.current = node as WebviewElement | null;
              }}
              className="pane-webview is-free-web"
              src={resolvedWebSrc}
              partition="persist:livehub"
              useragent={webUaMode === 'mobile' ? WEB_MOBILE_UA : WEB_DESKTOP_UA}
              {...WEBVIEW_ALLOW_POPUPS}
            />
          )}
          {(isLoading || !mountReady) && (
            <div className="web-loading-bar" aria-hidden="true">
              <span className="web-loading-bar-beam" />
            </div>
          )}
          {webLoadError && !isLoading && (
            <div className="pane-loading-overlay">
              <div className="direct-status-card">
                <div className="pane-empty-title">网页暂时无法打开</div>
                <div className="pane-empty-sub">
                  {webLoadError.desc} ({webLoadError.code})
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button
                    className="primary-btn"
                    onClick={() => {
                      setWebLoadError(null);
                      handleReload();
                    }}
                  >
                    <RefreshCw size={12} />
                    <span>重新加载</span>
                  </button>
                  <button className="icon-btn" onClick={handleOpenWebExternal}>
                    <ExternalLink size={12} />
                    <span>浏览器打开</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : pane.url && webviewPreloadPath ? (
        <>
          {mountReady && (
            <webview
              key={`${pane.slotIndex}-${pane.url}`}
              ref={(node) => {
                webviewRef.current = node as WebviewElement | null;
              }}
              className="pane-webview"
              src={pane.url}
              partition="persist:livehub"
              preload={webviewPreloadPath}
              {...WEBVIEW_ALLOW_POPUPS}
            />
          )}
          {(isLoading || !mountReady) && (
            <div className="pane-loading-overlay">
              <div className="pane-loading-pill">
                <span className="pane-spinner" />
                <span>正在加载 {platformMeta?.shortName || ''} 直播间...</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="pane-empty">
          <div className="pane-empty-card">
            <div className="pane-empty-title">画面 {pane.slotIndex + 1}</div>
            <div className="pane-empty-sub">
              从左侧点击或拖拽主播/网页到此窗格，或直接粘贴直播间链接与任意网址（抖音 / B站等，自动复用登录 Cookie）
            </div>
            <form className="pane-quick-form" onSubmit={(e) => void handleQuickSubmit(e)}>
              <input
                className="text-input"
                value={quickInput}
                onChange={(e) => {
                  setQuickInput(e.target.value);
                  setQuickPendingRoomId(null);
                  setQuickError(null);
                }}
                placeholder="粘贴直播间链接 / 任意网址 (douyin.com, bilibili.com)"
              />
              <button type="submit" className="primary-btn" disabled={quickResolving}>
                {quickResolving ? '解析中' : '打开'}
              </button>
            </form>
            {quickPendingRoomId && (
              <div className="platform-picker">
                {PLATFORM_LIST.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="platform-chip"
                    style={{ color: p.color, background: p.bgTint, borderColor: p.color }}
                    onClick={() => handleQuickPickPlatform(p.id)}
                  >
                    {p.shortName}
                  </button>
                ))}
              </div>
            )}
            {quickError && <div className="form-hint">{quickError}</div>}
            {channels.length > 0 && (
              <div className="pane-quick-chips">
                {channels.slice(0, 6).map((ch) => {
                  const meta = getChannelPlatformMeta(ch.platform);
                  return (
                    <button
                      key={ch.id}
                      className="quick-channel-chip"
                      onClick={() => onLoadChannelInPane(pane.slotIndex, ch)}
                    >
                      <span style={{ color: meta.color, fontWeight: 600 }}>{meta.shortName}</span>
                      <span>{ch.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="pane-empty-web-row">
              <span className="pane-empty-web-label">边看边刷</span>
              {QUICK_WEB_PRESETS.map((site) => (
                <button
                  key={site.url}
                  type="button"
                  className="quick-channel-chip quick-web-chip"
                  onClick={() =>
                    onLoadUrlInPane(pane.slotIndex, site.url, site.name, null, 'web')
                  }
                  title={`在此窗格打开 ${site.name}（复用已登录 Cookie）`}
                >
                  <Globe size={11} style={{ color: '#6366f1' }} />
                  <span>{site.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
