import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { LAYOUT_CONFIGS } from '../../shared/platforms';
import type {
  AppSettings,
  AuthStatusMap,
  Channel,
  DanmakuArea,
  DanmakuMode,
  PaneSlot,
  PaneViewMode,
  PlatformId,
  SplitRatios,
} from '../../shared/types';
import { LivePane } from './LivePane';

interface SplitGridProps {
  settings: AppSettings;
  authStatus: AuthStatusMap;
  reloadEpochs: Record<PlatformId, number>;
  slotReloadTicks: number[];
  channels: Channel[];
  activeSlotIndex: number;
  maximizedSlotIndex: number | null;
  webviewPreloadPath: string;
  onSelectPane: (slotIndex: number) => void;
  onToggleMaximize: (slotIndex: number) => void;
  onChangeSplitRatios: (ratios: SplitRatios) => void;
  onLoadUrlInPane: (slotIndex: number, url: string, title?: string, channelId?: string | null) => void;
  onLoadChannelInPane: (slotIndex: number, channel: Channel) => void;
  onToggleMute: (slotIndex: number) => void;
  onToggleSolo: (slotIndex: number) => void;
  onToggleMode: (slotIndex: number, mode: PaneViewMode) => void;
  onUpdateTitle: (slotIndex: number, title: string) => void;
  onUpdatePanePrefs: (
    slotIndex: number,
    patch: Partial<
      Pick<PaneSlot, 'volume' | 'fitMode' | 'preferredQualityId' | 'preferredLineId' | 'danmakuEnabled'>
    >
  ) => void;
  onClearPane: (slotIndex: number) => void;
  onSwapPanes: (fromSlot: number, toSlot: number) => void;
  onLoginPlatform: (platform: PlatformId) => void;
  onChangeDanmakuArea: (area: DanmakuArea) => void;
  onChangeDanmakuOpacity: (opacity: number) => void;
  onChangeDanmakuFontSize: (size: number) => void;
  onChangeDanmakuSpeed: (speed: number) => void;
  onChangeDanmakuMode: (mode: DanmakuMode) => void;
  onChangeDanmakuBlockKeywords: (keywords: string[]) => void;
}

function getLayoutClassName(layout: AppSettings['layout']): string {
  if (layout === '1+2') return 'layout-1plus2';
  return `layout-${layout}`;
}

export function SplitGrid({
  settings,
  authStatus,
  reloadEpochs,
  slotReloadTicks,
  channels,
  activeSlotIndex,
  maximizedSlotIndex,
  webviewPreloadPath,
  onSelectPane,
  onToggleMaximize,
  onChangeSplitRatios,
  onLoadUrlInPane,
  onLoadChannelInPane,
  onToggleMute,
  onToggleSolo,
  onToggleMode,
  onUpdateTitle,
  onUpdatePanePrefs,
  onClearPane,
  onSwapPanes,
  onLoginPlatform,
  onChangeDanmakuArea,
  onChangeDanmakuOpacity,
  onChangeDanmakuFontSize,
  onChangeDanmakuSpeed,
  onChangeDanmakuMode,
  onChangeDanmakuBlockKeywords,
}: SplitGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [draggingAxis, setDraggingAxis] = useState<'col' | 'row' | null>(null);

  const visibleCount = LAYOUT_CONFIGS[settings.layout].count;
  const visiblePanes = settings.panes.slice(0, visibleCount);
  const effectiveMaxSlot =
    maximizedSlotIndex !== null && maximizedSlotIndex < visibleCount ? maximizedSlotIndex : null;
  const canMaximize = visibleCount > 1;

  const colRatio = Math.max(20, Math.min(80, settings.splitRatios?.col ?? (settings.layout === '1+2' ? 64 : 50)));
  const rowRatio = Math.max(20, Math.min(80, settings.splitRatios?.row ?? 50));

  const ratiosRef = useRef({ col: colRatio, row: rowRatio });
  ratiosRef.current = { col: colRatio, row: rowRatio };

  useEffect(() => {
    if (!draggingAxis) return;

    const handleMove = (e: MouseEvent) => {
      const grid = gridRef.current;
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      if (draggingAxis === 'col' && rect.width > 0) {
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.max(20, Math.min(80, Math.round(pct * 10) / 10));
        onChangeSplitRatios({ ...ratiosRef.current, col: clamped });
      } else if (draggingAxis === 'row' && rect.height > 0) {
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        const clamped = Math.max(20, Math.min(80, Math.round(pct * 10) / 10));
        onChangeSplitRatios({ ...ratiosRef.current, row: clamped });
      }
    };

    const handleUp = () => {
      setDraggingAxis(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [draggingAxis, onChangeSplitRatios]);

  const gridStyle: CSSProperties = {};
  if (effectiveMaxSlot !== null) {
    gridStyle.gridTemplateColumns = '1fr';
    gridStyle.gridTemplateRows = '1fr';
  } else if (settings.layout === '1x2') {
    gridStyle.gridTemplateColumns = `${colRatio}fr ${100 - colRatio}fr`;
  } else if (settings.layout === '2x1') {
    gridStyle.gridTemplateRows = `${rowRatio}fr ${100 - rowRatio}fr`;
  } else if (settings.layout === '1+2') {
    gridStyle.gridTemplateColumns = `${colRatio}fr ${100 - colRatio}fr`;
    gridStyle.gridTemplateRows = `${rowRatio}fr ${100 - rowRatio}fr`;
  } else if (settings.layout === '2x2') {
    gridStyle.gridTemplateColumns = `${colRatio}fr ${100 - colRatio}fr`;
    gridStyle.gridTemplateRows = `${rowRatio}fr ${100 - rowRatio}fr`;
  }

  const showColHandle =
    effectiveMaxSlot === null &&
    (settings.layout === '1x2' || settings.layout === '1+2' || settings.layout === '2x2');
  const showRowHandle =
    effectiveMaxSlot === null &&
    (settings.layout === '2x1' || settings.layout === '1+2' || settings.layout === '2x2');

  return (
    <main className="stage">
      <div
        ref={gridRef}
        className={`split-grid ${getLayoutClassName(settings.layout)} ${
          effectiveMaxSlot !== null ? 'has-maximized' : ''
        } ${draggingAxis ? 'is-resizing' : ''}`}
        style={gridStyle}
      >
        {visiblePanes.map((pane) => {
          const isSolo = settings.soloSlotIndex === pane.slotIndex;
          const effectiveMuted =
            settings.globalMuted ||
            (settings.soloSlotIndex !== null
              ? settings.soloSlotIndex !== pane.slotIndex
              : pane.muted);
          const isPlatformLoggedIn = pane.platform
            ? Boolean(authStatus[pane.platform]?.loggedIn)
            : true;
          const platformReloadEpoch = pane.platform ? reloadEpochs[pane.platform] : 0;
          const isMaximized = effectiveMaxSlot === pane.slotIndex;
          const isHiddenByMaximize =
            effectiveMaxSlot !== null && effectiveMaxSlot !== pane.slotIndex;

          return (
            <LivePane
              key={pane.slotIndex}
              pane={pane}
              isActive={activeSlotIndex === pane.slotIndex}
              isSolo={isSolo}
              isMaximized={isMaximized}
              canMaximize={canMaximize}
              isHiddenByMaximize={isHiddenByMaximize}
              effectiveMuted={effectiveMuted}
              isPlatformLoggedIn={isPlatformLoggedIn}
              platformReloadEpoch={platformReloadEpoch}
              slotReloadTick={slotReloadTicks[pane.slotIndex] ?? 0}
              channels={channels}
              webviewPreloadPath={webviewPreloadPath}
              autoHighestQuality={settings.autoHighestQuality}
              hideGiftEffects={settings.hideGiftEffects}
              danmakuEnabled={settings.danmakuEnabled}
              danmakuArea={settings.danmakuArea ?? 'half'}
              danmakuOpacity={settings.danmakuOpacity ?? 0.85}
              danmakuFontSize={settings.danmakuFontSize ?? 18}
              danmakuSpeed={settings.danmakuSpeed ?? 1}
              danmakuMode={settings.danmakuMode ?? 'scroll'}
              danmakuBlockKeywords={settings.danmakuBlockKeywords ?? []}
              onChangeDanmakuArea={onChangeDanmakuArea}
              onChangeDanmakuOpacity={onChangeDanmakuOpacity}
              onChangeDanmakuFontSize={onChangeDanmakuFontSize}
              onChangeDanmakuSpeed={onChangeDanmakuSpeed}
              onChangeDanmakuMode={onChangeDanmakuMode}
              onChangeDanmakuBlockKeywords={onChangeDanmakuBlockKeywords}
              onUpdatePanePrefs={onUpdatePanePrefs}
              onToggleMaximize={onToggleMaximize}
              onSelectPane={onSelectPane}
              onLoadUrlInPane={onLoadUrlInPane}
              onLoadChannelInPane={onLoadChannelInPane}
              onToggleMute={onToggleMute}
              onToggleSolo={onToggleSolo}
              onToggleMode={onToggleMode}
              onUpdateTitle={onUpdateTitle}
              onClearPane={onClearPane}
              onSwapPanes={onSwapPanes}
              onLoginPlatform={onLoginPlatform}
            />
          );
        })}

        {showColHandle && (
          <div
            className={`split-divider split-divider-col ${draggingAxis === 'col' ? 'dragging' : ''}`}
            style={{ left: `calc(${colRatio}% - 4px)` }}
            onMouseDown={(e) => {
              e.preventDefault();
              setDraggingAxis('col');
            }}
            onDoubleClick={() =>
              onChangeSplitRatios({
                ...ratiosRef.current,
                col: settings.layout === '1+2' ? 64 : 50,
              })
            }
            title="左右拖拽调整分屏比例（双击还原默认）"
          />
        )}

        {showRowHandle && (
          <div
            className={`split-divider split-divider-row ${draggingAxis === 'row' ? 'dragging' : ''}`}
            style={
              settings.layout === '1+2'
                ? { top: `calc(${rowRatio}% - 4px)`, left: `calc(${colRatio}% + 4px)`, right: 0 }
                : { top: `calc(${rowRatio}% - 4px)`, left: 0, right: 0 }
            }
            onMouseDown={(e) => {
              e.preventDefault();
              setDraggingAxis('row');
            }}
            onDoubleClick={() =>
              onChangeSplitRatios({ ...ratiosRef.current, row: 50 })
            }
            title="上下拖拽调整分屏比例（双击还原默认）"
          />
        )}

        {draggingAxis && (
          <div
            className={`split-drag-shield ${draggingAxis === 'col' ? 'col-cursor' : 'row-cursor'}`}
          />
        )}
      </div>
    </main>
  );
}
