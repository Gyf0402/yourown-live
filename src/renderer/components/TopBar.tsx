import { useEffect, useRef, useState } from 'react';
import {
  EyeOff,
  KeyRound,
  MessageSquare,
  MessageSquareOff,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tv,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { LAYOUT_CONFIGS, PLATFORM_LIST } from '../../shared/platforms';
import type {
  AppSettings,
  AuthStatusMap,
  DanmakuArea,
  DanmakuMode,
  LayoutMode,
  ThemeMode,
} from '../../shared/types';
import { DANMAKU_AREA_OPTIONS, DanmakuSettingsPopover } from './DanmakuSettingsPopover';

interface TopBarProps {
  settings: AppSettings;
  authStatus: AuthStatusMap;
  onToggleSidebar: () => void;
  onChangeLayout: (layout: LayoutMode) => void;
  onToggleGlobalMute: () => void;
  onToggleAlwaysOnTop: () => void;
  onToggleAutoQuality: () => void;
  onToggleHideGifts: () => void;
  onToggleDanmaku: () => void;
  onChangeDanmakuArea: (area: DanmakuArea) => void;
  onChangeDanmakuOpacity: (opacity: number) => void;
  onChangeDanmakuFontSize: (size: number) => void;
  onChangeDanmakuSpeed: (speed: number) => void;
  onChangeDanmakuMode: (mode: DanmakuMode) => void;
  onChangeDanmakuBlockKeywords: (keywords: string[]) => void;
  onCycleTheme: () => void;
  onBossHide: () => void;
  onOpenLoginModal: () => void;
}

const LAYOUT_ORDER: LayoutMode[] = ['1x1', '1x2', '2x1', '1+2', '2x2'];

const THEME_LABELS: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '暗色',
  system: '跟随系统',
};

export function TopBar({
  settings,
  authStatus,
  onToggleSidebar,
  onChangeLayout,
  onToggleGlobalMute,
  onToggleAlwaysOnTop,
  onToggleAutoQuality,
  onToggleHideGifts,
  onToggleDanmaku,
  onChangeDanmakuArea,
  onChangeDanmakuOpacity,
  onChangeDanmakuFontSize,
  onChangeDanmakuSpeed,
  onChangeDanmakuMode,
  onChangeDanmakuBlockKeywords,
  onCycleTheme,
  onBossHide,
  onOpenLoginModal,
}: TopBarProps) {
  const loggedInCount = PLATFORM_LIST.filter((p) => authStatus[p.id]?.loggedIn).length;
  const [dmMenuOpen, setDmMenuOpen] = useState(false);
  const dmPopoverRef = useRef<HTMLDivElement | null>(null);

  const danmakuArea: DanmakuArea = settings.danmakuArea ?? 'half';
  const danmakuOpacity = settings.danmakuOpacity ?? 0.85;
  const danmakuFontSize = settings.danmakuFontSize ?? 18;
  const danmakuSpeed = settings.danmakuSpeed ?? 1;
  const danmakuMode: DanmakuMode = settings.danmakuMode ?? 'scroll';
  const danmakuBlockKeywords = settings.danmakuBlockKeywords ?? [];
  const theme: ThemeMode = settings.theme ?? 'light';

  const areaLabel =
    danmakuMode === 'chat'
      ? '聊天流'
      : (DANMAKU_AREA_OPTIONS.find((o) => o.id === danmakuArea)?.label ?? '半屏');

  useEffect(() => {
    if (!dmMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (dmPopoverRef.current && !dmPopoverRef.current.contains(e.target as Node)) {
        setDmMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDmMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dmMenuOpen]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon-btn"
          onClick={onToggleSidebar}
          title={settings.sidebarCollapsed ? '展开主播管理栏' : '折叠主播管理栏'}
        >
          {settings.sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>

        <div className="brand">
          <span className="brand-prism" aria-hidden="true">
            <span className="brand-prism-core" />
          </span>
          <span className="brand-name">聚合直播</span>
          <span className="brand-chip">PURE</span>
        </div>

        <div className="layout-group" role="group" aria-label="分屏布局">
          {LAYOUT_ORDER.map((mode) => (
            <button
              key={mode}
              className={`layout-pill ${settings.layout === mode ? 'active' : ''}`}
              onClick={() => onChangeLayout(mode)}
              title={LAYOUT_CONFIGS[mode].description}
            >
              {LAYOUT_CONFIGS[mode].label}
            </button>
          ))}
        </div>
      </div>

      <div className="topbar-right">
        <button
          className={`icon-btn danger ${settings.globalMuted ? 'active' : ''}`}
          onClick={onToggleGlobalMute}
          title="全局一键静音 / 恢复声音"
        >
          {settings.globalMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          <span>{settings.globalMuted ? '已全静音' : '全静音'}</span>
        </button>

        <button
          className={`icon-btn ${settings.autoHighestQuality ? 'active' : ''}`}
          onClick={onToggleAutoQuality}
          title="进房尝试自动切换最高画质（原画/蓝光）"
        >
          <Tv size={14} />
          <span>最高画质</span>
        </button>

        <button
          className={`icon-btn ${settings.hideGiftEffects ? 'active' : ''}`}
          onClick={onToggleHideGifts}
          title="屏蔽礼物动画、横幅与 PK 特效"
        >
          <Sparkles size={14} />
          <span>去礼物特效</span>
        </button>

        <div className="dm-control-anchor" ref={dmPopoverRef}>
          <button
            className={`icon-btn ${settings.danmakuEnabled ? 'active' : ''}`}
            onClick={onToggleDanmaku}
            title="全局默认开启/隐藏弹幕层"
          >
            {settings.danmakuEnabled ? <MessageSquare size={14} /> : <MessageSquareOff size={14} />}
            <span>{settings.danmakuEnabled ? '弹幕开' : '弹幕关'}</span>
          </button>
          <button
            className={`icon-btn ${dmMenuOpen ? 'active' : ''}`}
            onClick={() => setDmMenuOpen((v) => !v)}
            title="设置弹幕模式、显示区域、透明度、字号、速度与屏蔽词"
          >
            <SlidersHorizontal size={13} />
            <span>
              {areaLabel} · {Math.round(danmakuOpacity * 100)}%
            </span>
          </button>

          {dmMenuOpen && (
            <DanmakuSettingsPopover
              variant="topbar"
              area={danmakuArea}
              opacity={danmakuOpacity}
              fontSize={danmakuFontSize}
              speed={danmakuSpeed}
              mode={danmakuMode}
              blockKeywords={danmakuBlockKeywords}
              onChangeArea={onChangeDanmakuArea}
              onChangeOpacity={onChangeDanmakuOpacity}
              onChangeFontSize={onChangeDanmakuFontSize}
              onChangeSpeed={onChangeDanmakuSpeed}
              onChangeMode={onChangeDanmakuMode}
              onChangeBlockKeywords={onChangeDanmakuBlockKeywords}
            />
          )}
        </div>

        <button
          className={`icon-btn ${theme === 'dark' ? 'active' : ''}`}
          onClick={onCycleTheme}
          title={`当前外观：${THEME_LABELS[theme]}（点击切换 浅色 / 暗色观影 / 跟随系统）`}
        >
          {theme === 'dark' ? (
            <Moon size={14} />
          ) : theme === 'system' ? (
            <Monitor size={14} />
          ) : (
            <Sun size={14} />
          )}
          <span>{THEME_LABELS[theme]}</span>
        </button>

        <button
          className={`icon-btn warning ${settings.alwaysOnTop ? 'active' : ''}`}
          onClick={onToggleAlwaysOnTop}
          title="窗口置顶"
        >
          <Pin size={14} />
          <span>置顶</span>
        </button>

        <button
          className="icon-btn"
          onClick={onBossHide}
          title={`老板键 (${settings.bossKeyShortcut || 'Alt+X'})：一键静音并隐藏窗口`}
        >
          <EyeOff size={14} />
          <span>老板键 ({settings.bossKeyShortcut || 'Alt+X'})</span>
        </button>

        <button
          className={`icon-btn ${loggedInCount > 0 ? 'active' : 'warning active'}`}
          onClick={onOpenLoginModal}
          title="四平台账号登录、收藏备份与连接诊断"
        >
          <span className={`auth-dot ${loggedInCount > 0 ? 'online' : ''}`} />
          <KeyRound size={14} />
          <span>{loggedInCount > 0 ? `账号 (${loggedInCount}/4)` : '登录解锁高画质'}</span>
        </button>
      </div>
    </header>
  );
}
