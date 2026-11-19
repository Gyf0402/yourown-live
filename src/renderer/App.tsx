import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_GROUPS,
  LAYOUT_CONFIGS,
  PLATFORMS,
  SAMPLE_CHANNELS,
  detectPlatformFromUrl,
} from '../shared/platforms';
import type {
  AppSettings,
  AuthStatusMap,
  Channel,
  DanmakuArea,
  DanmakuMode,
  LayoutMode,
  LiveRoomStatus,
  PaneSlot,
  PaneViewMode,
  PersistedState,
  PlatformId,
  SplitRatios,
  ThemeMode,
} from '../shared/types';
import { LoginModal } from './components/LoginModal';
import { Sidebar } from './components/Sidebar';
import { SplitGrid } from './components/SplitGrid';
import { TopBar } from './components/TopBar';

const DEFAULT_AUTH_STATUS: AuthStatusMap = {
  huya: { loggedIn: false },
  douyu: { loggedIn: false },
  bilibili: { loggedIn: false },
  douyin: { loggedIn: false },
};

const DEFAULT_EPOCHS: Record<PlatformId, number> = {
  huya: 0,
  douyu: 0,
  bilibili: 0,
  douyin: 0,
};

const FALLBACK_SETTINGS: AppSettings = {
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
  splitRatios: { col: 50, row: 50 },
  bossKeyShortcut: 'Alt+X',
  panes: [0, 1, 2, 3].map((slotIndex) => ({
    slotIndex,
    channelId: null,
    url: null,
    platform: null,
    title: `画面 ${slotIndex + 1}`,
    muted: slotIndex !== 0,
    mode: 'pure',
    volume: 1,
    fitMode: 'contain',
  })),
};

const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'system'];

function isPlaceholderChannelName(ch: Channel): boolean {
  const shortName = PLATFORMS[ch.platform].shortName;
  const trimmed = ch.name.trim();
  return (
    trimmed === ch.roomId ||
    trimmed === `${shortName} ${ch.roomId}` ||
    trimmed === `${ch.platform} ${ch.roomId}`
  );
}

export function App() {
  const [channels, setChannels] = useState<Channel[]>(SAMPLE_CHANNELS);
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS);
  const [authStatus, setAuthStatus] = useState<AuthStatusMap>(DEFAULT_AUTH_STATUS);
  const [reloadEpochs, setReloadEpochs] = useState<Record<PlatformId, number>>(DEFAULT_EPOCHS);
  const [slotReloadTicks, setSlotReloadTicks] = useState<number[]>([0, 0, 0, 0]);
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  const [maximizedSlotIndex, setMaximizedSlotIndex] = useState<number | null>(null);
  const [webviewPreloadPath, setWebviewPreloadPath] = useState('');
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [splashStage, setSplashStage] = useState<'visible' | 'leaving' | 'gone'>('visible');
  const [liveStatuses, setLiveStatuses] = useState<Record<string, LiveRoomStatus>>({});
  const [checkingStatuses, setCheckingStatuses] = useState(false);
  const muteBeforeBossRef = useRef<boolean | null>(null);
  const prevAuthRef = useRef<AuthStatusMap>(DEFAULT_AUTH_STATUS);
  const channelsRef = useRef<Channel[]>(channels);
  channelsRef.current = channels;
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  const activeSlotRef = useRef(activeSlotIndex);
  activeSlotRef.current = activeSlotIndex;
  const checkingStatusesRef = useRef(false);

  const applyAuthStatusUpdate = useCallback(
    (nextStatus: AuthStatusMap, changedPlatform?: PlatformId) => {
      const prev = prevAuthRef.current;
      const platformsToReload: PlatformId[] = [];
      (['huya', 'douyu', 'bilibili', 'douyin'] as PlatformId[]).forEach((pid) => {
        if (!prev[pid]?.loggedIn && nextStatus[pid]?.loggedIn) {
          platformsToReload.push(pid);
        } else if (changedPlatform === pid && nextStatus[pid]?.loggedIn && !prev[pid]?.loggedIn) {
          platformsToReload.push(pid);
        }
      });
      prevAuthRef.current = nextStatus;
      setAuthStatus(nextStatus);

      if (platformsToReload.length > 0) {
        // Clear any previously pinned low quality on newly authenticated platforms so
        // autoHighestQuality immediately upgrades Bilibili/etc. from 720P to 1080P 原画.
        setSettings((prev) => {
          if (!prev.autoHighestQuality) return prev;
          let changed = false;
          const nextPanes = prev.panes.map((p) => {
            if (p.platform && platformsToReload.includes(p.platform) && p.preferredQualityId) {
              changed = true;
              return { ...p, preferredQualityId: undefined };
            }
            return p;
          });
          return changed ? { ...prev, panes: nextPanes } : prev;
        });
        setReloadEpochs((epochs) => {
          const updated = { ...epochs };
          platformsToReload.forEach((pid) => {
            updated[pid] = (updated[pid] || 0) + 1;
          });
          return updated;
        });
      }
    },
    []
  );

  // Sync light/dark/system theme with DOM attribute and Windows titlebar overlay
  useEffect(() => {
    const mode: ThemeMode = settings.theme ?? 'light';
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const isDark = mode === 'dark' || (mode === 'system' && media.matches);
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
      if (typeof window.livehub?.setWindowTheme === 'function') {
        void window.livehub.setWindowTheme(isDark);
      }
    };

    applyTheme();
    if (mode === 'system') {
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }
  }, [settings.theme]);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      window.livehub.loadState(),
      window.livehub.getWebviewPreloadPath(),
      window.livehub.getAuthStatus(),
    ]).then(([state, preloadPath, initialAuth]) => {
      if (!mounted) return;
      setChannels(state.channels);
      setSettings(state.settings);
      setWebviewPreloadPath(preloadPath);
      prevAuthRef.current = initialAuth;
      setAuthStatus(initialAuth);
      setHydrated(true);
      if (state.settings.alwaysOnTop) {
        void window.livehub.setAlwaysOnTop(true);
      }
    });

    const unlistenBoss = window.livehub.onBossKeyTriggered((hidden) => {
      setSettings((prev) => {
        if (hidden) {
          muteBeforeBossRef.current = prev.globalMuted;
          return { ...prev, globalMuted: true };
        }
        const restoreMute = muteBeforeBossRef.current ?? false;
        muteBeforeBossRef.current = null;
        return { ...prev, globalMuted: restoreMute };
      });
    });

    const unlistenAuth = window.livehub.onAuthStatusChanged(({ status, changedPlatform }) => {
      applyAuthStatusUpdate(status, changedPlatform);
    });

    const unlistenTray =
      typeof window.livehub.onTrayAction === 'function'
        ? window.livehub.onTrayAction((action) => {
            if (action === 'toggle-mute') {
              setSettings((prev) => ({ ...prev, globalMuted: !prev.globalMuted }));
            } else if (action === 'open-settings') {
              setLoginModalOpen(true);
            }
          })
        : () => {};

    const unlistenClose =
      typeof window.livehub.onBeforeWindowClose === 'function'
        ? window.livehub.onBeforeWindowClose(() => {
            void window.livehub.saveState({
              channels: channelsRef.current,
              settings: settingsRef.current,
            });
          })
        : () => {};

    return () => {
      mounted = false;
      unlistenBoss();
      unlistenAuth();
      unlistenTray();
      unlistenClose();
    };
  }, [applyAuthStatusUpdate]);

  // Debounced persistence + immediate flush on unload
  useEffect(() => {
    if (!hydrated) return;
    const payload: PersistedState = { channels, settings };
    const timer = window.setTimeout(() => {
      void window.livehub.saveState(payload);
    }, 280);
    const flushNow = () => {
      void window.livehub.saveState(payload);
    };
    window.addEventListener('beforeunload', flushNow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('beforeunload', flushNow);
    };
  }, [channels, settings, hydrated]);

  const refreshLiveStatuses = useCallback(async (targetList?: Channel[]) => {
    const list = targetList ?? channelsRef.current;
    if (
      list.length === 0 ||
      typeof window.livehub?.checkLiveStatuses !== 'function'
    ) {
      return;
    }
    if (!targetList && checkingStatusesRef.current) return;
    if (!targetList) {
      checkingStatusesRef.current = true;
      setCheckingStatuses(true);
    }
    try {
      const res = await window.livehub.checkLiveStatuses(
        list.map((c) => ({ id: c.id, platform: c.platform, roomId: c.roomId }))
      );
      if (res && typeof res === 'object') {
        setLiveStatuses((prev) => ({ ...prev, ...res }));
        // Auto-fill friendly anchorName for newly added channels that still have placeholder names
        const renamedMap = new Map<string, string>();
        setChannels((prev) => {
          let changed = false;
          const next = prev.map((ch) => {
            const info = res[ch.id];
            const anchor = info?.anchorName?.trim();
            if (anchor && !ch.remarkLocked && isPlaceholderChannelName(ch) && ch.name !== anchor) {
              changed = true;
              renamedMap.set(ch.id, anchor);
              return { ...ch, name: anchor };
            }
            return ch;
          });
          return changed ? next : prev;
        });
        if (renamedMap.size > 0) {
          setSettings((prev) => {
            let changed = false;
            const nextPanes = prev.panes.map((p) => {
              if (p.channelId && renamedMap.has(p.channelId)) {
                changed = true;
                return { ...p, title: renamedMap.get(p.channelId)! };
              }
              return p;
            });
            return changed ? { ...prev, panes: nextPanes } : prev;
          });
        }
      }
    } catch {
      // Ignore transient network failures
    } finally {
      if (!targetList) {
        checkingStatusesRef.current = false;
        setCheckingStatuses(false);
      }
    }
  }, []);

  // Smooth Apple-style opening curtain reveal once state is hydrated
  useEffect(() => {
    if (!hydrated) return;
    const leaveTimer = window.setTimeout(() => setSplashStage('leaving'), 260);
    const goneTimer = window.setTimeout(() => setSplashStage('gone'), 760);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(goneTimer);
    };
  }, [hydrated]);

  // Auto-check all channels on startup and every 60s
  useEffect(() => {
    if (!hydrated) return;
    void refreshLiveStatuses();
    const timer = window.setInterval(() => {
      void refreshLiveStatuses();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [hydrated, refreshLiveStatuses]);

  const playingChannelIds = useMemo(() => {
    const visibleCount = LAYOUT_CONFIGS[settings.layout].count;
    const ids = new Set<string>();
    settings.panes.slice(0, visibleCount).forEach((p) => {
      if (p.channelId && p.url) ids.add(p.channelId);
    });
    return ids;
  }, [settings.layout, settings.panes]);

  const loadUrlInPane = useCallback(
    (slotIndex: number, url: string, title?: string, channelId: string | null = null) => {
      const platform = detectPlatformFromUrl(url);
      setSettings((prev) => {
        const nextPanes = prev.panes.map((p) =>
          p.slotIndex === slotIndex
            ? {
                ...p,
                url,
                channelId,
                platform,
                title: title || (platform ? PLATFORMS[platform].name : '直播间'),
                preferredQualityId: undefined,
                preferredLineId: undefined,
              }
            : p
        );
        return { ...prev, panes: nextPanes };
      });
      setActiveSlotIndex(slotIndex);
    },
    []
  );

  const loadChannelInPane = useCallback(
    (slotIndex: number, channel: Channel) => {
      loadUrlInPane(slotIndex, channel.url, channel.name, channel.id);
    },
    [loadUrlInPane]
  );

  const openChannelSmart = useCallback(
    (channel: Channel) => {
      const visibleCount = LAYOUT_CONFIGS[settings.layout].count;
      const visiblePanes = settings.panes.slice(0, visibleCount);

      const existing = visiblePanes.find((p) => p.channelId === channel.id && p.url);
      if (existing) {
        setActiveSlotIndex(existing.slotIndex);
        return;
      }

      const activePane = visiblePanes.find((p) => p.slotIndex === activeSlotIndex);
      const targetSlot =
        (activePane && !activePane.url ? activePane.slotIndex : null) ??
        visiblePanes.find((p) => !p.url)?.slotIndex ??
        (activeSlotIndex < visibleCount ? activeSlotIndex : 0);

      loadChannelInPane(targetSlot, channel);
    },
    [settings.layout, settings.panes, activeSlotIndex, loadChannelInPane]
  );

  const handleAddChannel = useCallback(
    (channel: Channel, openImmediately = true) => {
      setChannels((prev) => [channel, ...prev]);
      void refreshLiveStatuses([channel]);
      if (openImmediately) {
        openChannelSmart(channel);
      }
    },
    [openChannelSmart, refreshLiveStatuses]
  );

  const handleRemoveChannel = useCallback((id: string) => {
    setChannels((prev) => prev.filter((c) => c.id !== id));
    setSettings((prev) => {
      if (!prev.panes.some((p) => p.channelId === id)) return prev;
      return {
        ...prev,
        panes: prev.panes.map((p) => (p.channelId === id ? { ...p, channelId: null } : p)),
      };
    });
  }, []);

  const handleTogglePin = useCallback((id: string) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c))
    );
  }, []);

  const handleRenameChannel = useCallback((id: string, nextName: string, nextGroup?: string) => {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    setChannels((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              name: trimmed,
              remarkLocked: trimmed !== c.name ? true : c.remarkLocked,
              ...(nextGroup ? { group: nextGroup } : {}),
            }
          : c
      )
    );
    setSettings((prev) => {
      if (!prev.panes.some((p) => p.channelId === id)) return prev;
      return {
        ...prev,
        panes: prev.panes.map((p) =>
          p.channelId === id ? { ...p, title: trimmed } : p
        ),
      };
    });
  }, []);

  const handleAddGroup = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed || DEFAULT_GROUPS.includes(trimmed)) return;
    setSettings((prev) => {
      const existing = prev.customGroups ?? [];
      if (existing.includes(trimmed)) return prev;
      return { ...prev, customGroups: [...existing, trimmed] };
    });
  }, []);

  const handleRemoveGroup = useCallback((name: string) => {
    setSettings((prev) => ({
      ...prev,
      customGroups: (prev.customGroups ?? []).filter((g) => g !== name),
    }));
    setChannels((prev) =>
      prev.map((c) => (c.group === name ? { ...c, group: '综合' } : c))
    );
  }, []);

  const handleImportChannels = useCallback(
    (imported: Channel[], importedGroups: string[] = []) => {
      const existingKeys = new Set(
        channelsRef.current.map((c) => `${c.platform}:${c.roomId.toLowerCase()}`)
      );
      const toAdd: Channel[] = [];
      let skipped = 0;
      for (const ch of imported) {
        const key = `${ch.platform}:${ch.roomId.toLowerCase()}`;
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        existingKeys.add(key);
        toAdd.push(ch);
      }

      if (toAdd.length > 0) {
        setChannels((prev) => [...toAdd, ...prev]);
        void refreshLiveStatuses(toAdd);
      }

      const defaultSet = new Set(DEFAULT_GROUPS);
      const extraGroups = new Set<string>(importedGroups.filter((g) => g && !defaultSet.has(g)));
      toAdd.forEach((c) => {
        if (c.group && !defaultSet.has(c.group)) extraGroups.add(c.group);
      });
      if (extraGroups.size > 0) {
        setSettings((prev) => {
          const merged = Array.from(new Set([...(prev.customGroups ?? []), ...extraGroups]));
          return { ...prev, customGroups: merged };
        });
      }

      return { added: toAdd.length, skipped };
    },
    [refreshLiveStatuses]
  );

  const handleToggleMute = useCallback((slotIndex: number) => {
    setSettings((prev) => {
      // If globally muted, clicking unmute on a specific pane unmutes ONLY that pane cleanly
      if (prev.globalMuted) {
        return {
          ...prev,
          globalMuted: false,
          soloSlotIndex: null,
          panes: prev.panes.map((p) => ({
            ...p,
            muted: p.slotIndex === slotIndex ? false : true,
          })),
        };
      }
      if (prev.soloSlotIndex !== null && prev.soloSlotIndex !== slotIndex) {
        return {
          ...prev,
          globalMuted: false,
          soloSlotIndex: null,
          panes: prev.panes.map((p) =>
            p.slotIndex === slotIndex ? { ...p, muted: false } : p
          ),
        };
      }
      if (prev.soloSlotIndex === slotIndex) {
        return {
          ...prev,
          soloSlotIndex: null,
          panes: prev.panes.map((p) =>
            p.slotIndex === slotIndex ? { ...p, muted: true } : p
          ),
        };
      }
      return {
        ...prev,
        globalMuted: false,
        panes: prev.panes.map((p) =>
          p.slotIndex === slotIndex ? { ...p, muted: !p.muted } : p
        ),
      };
    });
  }, []);

  const handleToggleSolo = useCallback((slotIndex: number) => {
    setSettings((prev) => ({
      ...prev,
      globalMuted: false,
      soloSlotIndex: prev.soloSlotIndex === slotIndex ? null : slotIndex,
    }));
  }, []);

  const handleToggleMode = useCallback((slotIndex: number, mode: PaneViewMode) => {
    setSettings((prev) => ({
      ...prev,
      panes: prev.panes.map((p) => (p.slotIndex === slotIndex ? { ...p, mode } : p)),
    }));
  }, []);

  const handleUpdatePanePrefs = useCallback(
    (
      slotIndex: number,
      patch: Partial<
        Pick<
          PaneSlot,
          'volume' | 'fitMode' | 'preferredQualityId' | 'preferredLineId' | 'danmakuEnabled'
        >
      >
    ) => {
      setSettings((prev) => ({
        ...prev,
        panes: prev.panes.map((p) => (p.slotIndex === slotIndex ? { ...p, ...patch } : p)),
      }));
    },
    []
  );

  const handleUpdateTitle = useCallback(
    (slotIndex: number, title: string) => {
      setSettings((prev) => {
        const target = prev.panes[slotIndex];
        if (!target || target.title === title) return prev;
        if (target.channelId) {
          const ch = channels.find((c) => c.id === target.channelId);
          if (ch?.remarkLocked) return prev;
        }
        return {
          ...prev,
          panes: prev.panes.map((p) => (p.slotIndex === slotIndex ? { ...p, title } : p)),
        };
      });
    },
    [channels]
  );

  const handleClearPane = useCallback((slotIndex: number) => {
    setMaximizedSlotIndex((cur) => (cur === slotIndex ? null : cur));
    setSettings((prev) => ({
      ...prev,
      soloSlotIndex: prev.soloSlotIndex === slotIndex ? null : prev.soloSlotIndex,
      panes: prev.panes.map((p) =>
        p.slotIndex === slotIndex
          ? {
              ...p,
              channelId: null,
              url: null,
              platform: null,
              title: `画面 ${slotIndex + 1}`,
              preferredQualityId: undefined,
              preferredLineId: undefined,
            }
          : p
      ),
    }));
  }, []);

  const handleSwapPanes = useCallback((fromSlot: number, toSlot: number) => {
    if (fromSlot === toSlot) return;
    setSettings((prev) => {
      const a = prev.panes[fromSlot];
      const b = prev.panes[toSlot];
      if (!a || !b) return prev;
      const nextPanes = prev.panes.map((p) => {
        if (p.slotIndex === fromSlot) {
          return { ...b, slotIndex: fromSlot };
        }
        if (p.slotIndex === toSlot) {
          return { ...a, slotIndex: toSlot };
        }
        return p;
      });
      let nextSolo = prev.soloSlotIndex;
      if (nextSolo === fromSlot) nextSolo = toSlot;
      else if (nextSolo === toSlot) nextSolo = fromSlot;
      return { ...prev, panes: nextPanes, soloSlotIndex: nextSolo };
    });
    setMaximizedSlotIndex((cur) => {
      if (cur === fromSlot) return toSlot;
      if (cur === toSlot) return fromSlot;
      return cur;
    });
    setActiveSlotIndex(toSlot);
  }, []);

  const handleChangeLayout = useCallback((layout: LayoutMode) => {
    const nextCount = LAYOUT_CONFIGS[layout].count;
    setMaximizedSlotIndex((cur) => (cur !== null && cur >= nextCount ? null : cur));
    setActiveSlotIndex((cur) => (cur >= nextCount ? 0 : cur));
    setSettings((prev) => ({
      ...prev,
      layout,
      // Fix "ghost solo": never leave soloSlotIndex pointing at a hidden slot when shrinking layout
      soloSlotIndex:
        prev.soloSlotIndex !== null && prev.soloSlotIndex >= nextCount
          ? null
          : prev.soloSlotIndex,
      splitRatios:
        layout === '1+2'
          ? { col: 64, row: prev.splitRatios?.row ?? 50 }
          : { col: 50, row: 50 },
    }));
  }, []);

  const handleToggleMaximize = useCallback((slotIndex: number) => {
    setMaximizedSlotIndex((cur) => (cur === slotIndex ? null : slotIndex));
    setActiveSlotIndex(slotIndex);
  }, []);

  const handleChangeSplitRatios = useCallback((splitRatios: SplitRatios) => {
    setSettings((prev) => ({ ...prev, splitRatios }));
  }, []);

  const handleChangeDanmakuArea = useCallback((area: DanmakuArea) => {
    setSettings((prev) => ({ ...prev, danmakuArea: area }));
  }, []);

  const handleChangeDanmakuOpacity = useCallback((opacity: number) => {
    const clamped = Math.max(0.15, Math.min(1, Math.round(opacity * 100) / 100));
    setSettings((prev) => ({ ...prev, danmakuOpacity: clamped }));
  }, []);

  const handleChangeDanmakuFontSize = useCallback((size: number) => {
    const clamped = Math.max(12, Math.min(28, Math.round(size)));
    setSettings((prev) => ({ ...prev, danmakuFontSize: clamped }));
  }, []);

  const handleChangeDanmakuSpeed = useCallback((speed: number) => {
    const clamped = Math.max(0.6, Math.min(1.6, Math.round(speed * 10) / 10));
    setSettings((prev) => ({ ...prev, danmakuSpeed: clamped }));
  }, []);

  const handleChangeDanmakuMode = useCallback((mode: DanmakuMode) => {
    setSettings((prev) => ({ ...prev, danmakuMode: mode }));
  }, []);

  const handleChangeDanmakuBlockKeywords = useCallback((keywords: string[]) => {
    setSettings((prev) => ({ ...prev, danmakuBlockKeywords: keywords }));
  }, []);

  const handleCycleTheme = useCallback(() => {
    setSettings((prev) => {
      const cur: ThemeMode = prev.theme ?? 'light';
      const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
      return { ...prev, theme: next };
    });
  }, []);

  const handleToggleAlwaysOnTop = useCallback(async () => {
    const next = !settings.alwaysOnTop;
    const confirmed = await window.livehub.setAlwaysOnTop(next);
    setSettings((prev) => ({ ...prev, alwaysOnTop: confirmed }));
  }, [settings.alwaysOnTop]);

  const handleUpdateBossKey = useCallback(async (shortcut: string) => {
    const res = await window.livehub.setBossKeyShortcut(shortcut);
    if (res.ok) {
      setSettings((prev) => ({ ...prev, bossKeyShortcut: shortcut.trim() }));
    }
    return res;
  }, []);

  const handleLoginPlatform = useCallback((platform: PlatformId) => {
    void window.livehub.openPlatformLogin(platform);
  }, []);

  const handleRefreshAuth = useCallback(async () => {
    const next = await window.livehub.getAuthStatus();
    applyAuthStatusUpdate(next);
  }, [applyAuthStatusUpdate]);

  const handleClearPlatformCookies = useCallback(
    async (platform: PlatformId) => {
      const next = await window.livehub.clearPlatformCookies(platform);
      applyAuthStatusUpdate(next, platform);
    },
    [applyAuthStatusUpdate]
  );

  const handleReloadAllPanes = useCallback(() => {
    setReloadEpochs((epochs) => ({
      huya: epochs.huya + 1,
      douyu: epochs.douyu + 1,
      bilibili: epochs.bilibili + 1,
      douyin: epochs.douyin + 1,
    }));
  }, []);

  // Global keyboard shortcuts: 1-4 solo, M mute active, R reload active, Tab cycle pane, Esc restore/close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }

      if (e.key === 'Escape') {
        if (loginModalOpen) {
          setLoginModalOpen(false);
          return;
        }
        if (maximizedSlotIndex !== null && !document.fullscreenElement) {
          setMaximizedSlotIndex(null);
          return;
        }
        return;
      }

      if (loginModalOpen) return;

      const visibleCount = LAYOUT_CONFIGS[settingsRef.current.layout].count;
      if (e.key >= '1' && e.key <= '4') {
        const idx = Number(e.key) - 1;
        if (idx < visibleCount) {
          e.preventDefault();
          setActiveSlotIndex(idx);
          handleToggleSolo(idx);
        }
        return;
      }

      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        handleToggleMute(activeSlotRef.current);
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        const slot = activeSlotRef.current;
        setSlotReloadTicks((prev) => prev.map((v, i) => (i === slot ? v + 1 : v)));
        return;
      }

      if (e.key === 'Tab' && visibleCount > 1 && maximizedSlotIndex === null) {
        e.preventDefault();
        setActiveSlotIndex((cur) => (cur + 1) % visibleCount);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loginModalOpen, maximizedSlotIndex, handleToggleSolo, handleToggleMute]);

  return (
    <div className={`app-shell ${hydrated ? 'is-ready' : ''}`}>
      <div className="ambient-aurora" aria-hidden="true">
        <span className="aurora-orb orb-1" />
        <span className="aurora-orb orb-2" />
        <span className="aurora-orb orb-3" />
      </div>

      {splashStage !== 'gone' && (
        <div
          className={`boot-curtain ${splashStage === 'leaving' ? 'is-leaving' : ''}`}
          aria-hidden="true"
        >
          <div className="boot-emblem">
            <div className="boot-prism" />
            <div className="boot-title">YourOwn Live</div>
            <div className="boot-sub">自由选择爱看的主播 · 纯净流无广告看播台</div>
          </div>
        </div>
      )}

      <TopBar
        settings={settings}
        authStatus={authStatus}
        onToggleSidebar={() =>
          setSettings((prev) => ({ ...prev, sidebarCollapsed: !prev.sidebarCollapsed }))
        }
        onChangeLayout={handleChangeLayout}
        onToggleGlobalMute={() =>
          setSettings((prev) => ({ ...prev, globalMuted: !prev.globalMuted }))
        }
        onToggleAlwaysOnTop={() => void handleToggleAlwaysOnTop()}
        onToggleAutoQuality={() =>
          setSettings((prev) => ({
            ...prev,
            autoHighestQuality: !prev.autoHighestQuality,
          }))
        }
        onToggleHideGifts={() =>
          setSettings((prev) => ({
            ...prev,
            hideGiftEffects: !prev.hideGiftEffects,
          }))
        }
        onToggleDanmaku={() =>
          setSettings((prev) => {
            const nextEnabled = !prev.danmakuEnabled;
            return {
              ...prev,
              danmakuEnabled: nextEnabled,
              panes: prev.panes.map((p) => ({ ...p, danmakuEnabled: undefined })),
            };
          })
        }
        onChangeDanmakuArea={handleChangeDanmakuArea}
        onChangeDanmakuOpacity={handleChangeDanmakuOpacity}
        onChangeDanmakuFontSize={handleChangeDanmakuFontSize}
        onChangeDanmakuSpeed={handleChangeDanmakuSpeed}
        onChangeDanmakuMode={handleChangeDanmakuMode}
        onChangeDanmakuBlockKeywords={handleChangeDanmakuBlockKeywords}
        onCycleTheme={handleCycleTheme}
        onBossHide={() => void window.livehub.toggleBossHide()}
        onOpenLoginModal={() => setLoginModalOpen(true)}
      />

      <div className={`workspace ${settings.sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <div className={`sidebar-shell ${settings.sidebarCollapsed ? 'collapsed' : ''}`}>
          <Sidebar
            channels={channels}
            customGroups={settings.customGroups ?? []}
            authStatus={authStatus}
            playingChannelIds={playingChannelIds}
            liveStatuses={liveStatuses}
            checkingStatuses={checkingStatuses}
            onRefreshLiveStatuses={() => void refreshLiveStatuses()}
            onAddChannel={handleAddChannel}
            onRemoveChannel={handleRemoveChannel}
            onTogglePin={handleTogglePin}
            onRenameChannel={handleRenameChannel}
            onAddGroup={handleAddGroup}
            onRemoveGroup={handleRemoveGroup}
            onOpenChannel={openChannelSmart}
            onLoginPlatform={handleLoginPlatform}
            onOpenLoginModal={() => setLoginModalOpen(true)}
          />
        </div>

        <SplitGrid
          settings={settings}
          authStatus={authStatus}
          reloadEpochs={reloadEpochs}
          slotReloadTicks={slotReloadTicks}
          channels={channels}
          activeSlotIndex={activeSlotIndex}
          maximizedSlotIndex={maximizedSlotIndex}
          webviewPreloadPath={webviewPreloadPath}
          onSelectPane={setActiveSlotIndex}
          onToggleMaximize={handleToggleMaximize}
          onChangeSplitRatios={handleChangeSplitRatios}
          onLoadUrlInPane={loadUrlInPane}
          onLoadChannelInPane={loadChannelInPane}
          onToggleMute={handleToggleMute}
          onToggleSolo={handleToggleSolo}
          onToggleMode={handleToggleMode}
          onUpdateTitle={handleUpdateTitle}
          onUpdatePanePrefs={handleUpdatePanePrefs}
          onClearPane={handleClearPane}
          onSwapPanes={handleSwapPanes}
          onLoginPlatform={handleLoginPlatform}
          onChangeDanmakuArea={handleChangeDanmakuArea}
          onChangeDanmakuOpacity={handleChangeDanmakuOpacity}
          onChangeDanmakuFontSize={handleChangeDanmakuFontSize}
          onChangeDanmakuSpeed={handleChangeDanmakuSpeed}
          onChangeDanmakuMode={handleChangeDanmakuMode}
          onChangeDanmakuBlockKeywords={handleChangeDanmakuBlockKeywords}
        />
      </div>

      {loginModalOpen && (
        <LoginModal
          bossKeyShortcut={settings.bossKeyShortcut}
          authStatus={authStatus}
          channels={channels}
          customGroups={settings.customGroups ?? []}
          onClose={() => setLoginModalOpen(false)}
          onUpdateBossKey={handleUpdateBossKey}
          onRefreshAuth={handleRefreshAuth}
          onClearPlatformCookies={handleClearPlatformCookies}
          onReloadAllPanes={handleReloadAllPanes}
          onImportChannels={handleImportChannels}
        />
      )}
    </div>
  );
}
