import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { DanmakuArea, DanmakuMode } from '../../shared/types';

export const DANMAKU_AREA_OPTIONS: Array<{ id: DanmakuArea; label: string }> = [
  { id: 'third', label: '1/3屏' },
  { id: 'half', label: '半屏' },
  { id: 'full', label: '全屏' },
];

export const DANMAKU_MODE_OPTIONS: Array<{ id: DanmakuMode; label: string }> = [
  { id: 'scroll', label: '滚屏弹幕' },
  { id: 'chat', label: '迷你聊天流' },
];

interface DanmakuSettingsPopoverProps {
  variant: 'topbar' | 'player';
  area: DanmakuArea;
  opacity: number;
  fontSize: number;
  speed: number;
  mode: DanmakuMode;
  blockKeywords: string[];
  onChangeArea: (area: DanmakuArea) => void;
  onChangeOpacity: (opacity: number) => void;
  onChangeFontSize: (size: number) => void;
  onChangeSpeed: (speed: number) => void;
  onChangeMode: (mode: DanmakuMode) => void;
  onChangeBlockKeywords: (keywords: string[]) => void;
}

export function DanmakuSettingsPopover({
  variant,
  area,
  opacity,
  fontSize,
  speed,
  mode,
  blockKeywords,
  onChangeArea,
  onChangeOpacity,
  onChangeFontSize,
  onChangeSpeed,
  onChangeMode,
  onChangeBlockKeywords,
}: DanmakuSettingsPopoverProps) {
  const [kwInput, setKwInput] = useState('');

  const handleAddKeyword = () => {
    const trimmed = kwInput.trim();
    if (!trimmed) return;
    if (!blockKeywords.includes(trimmed)) {
      onChangeBlockKeywords([...blockKeywords, trimmed]);
    }
    setKwInput('');
  };

  const handleRemoveKeyword = (kw: string) => {
    onChangeBlockKeywords(blockKeywords.filter((k) => k !== kw));
  };

  return (
    <div
      className={`dm-style-popover ${variant === 'topbar' ? 'topbar-popover' : 'player-popover'}`}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="dm-style-row">
        <span className="dm-style-label">呈现形式</span>
        <div className="dm-area-segment two-col">
          {DANMAKU_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`dm-area-btn ${mode === opt.id ? 'active' : ''}`}
              onClick={() => onChangeMode(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'scroll' && (
        <div className="dm-style-row">
          <span className="dm-style-label">显示区域</span>
          <div className="dm-area-segment">
            {DANMAKU_AREA_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`dm-area-btn ${area === opt.id ? 'active' : ''}`}
                onClick={() => onChangeArea(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="dm-style-row">
        <div className="dm-style-label-row">
          <span className="dm-style-label">不透明度</span>
          <span className="dm-style-val">{Math.round(opacity * 100)}%</span>
        </div>
        <input
          type="range"
          className="dm-opacity-slider"
          min={15}
          max={100}
          step={5}
          value={Math.round(opacity * 100)}
          onChange={(e) => onChangeOpacity(Number(e.target.value) / 100)}
        />
      </div>

      <div className="dm-style-row">
        <div className="dm-style-label-row">
          <span className="dm-style-label">字号</span>
          <span className="dm-style-val">{fontSize}px</span>
        </div>
        <input
          type="range"
          className="dm-opacity-slider"
          min={12}
          max={28}
          step={1}
          value={fontSize}
          onChange={(e) => onChangeFontSize(Number(e.target.value))}
        />
      </div>

      {mode === 'scroll' && (
        <div className="dm-style-row">
          <div className="dm-style-label-row">
            <span className="dm-style-label">滚动速度</span>
            <span className="dm-style-val">{speed.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            className="dm-opacity-slider"
            min={60}
            max={160}
            step={10}
            value={Math.round(speed * 100)}
            onChange={(e) => onChangeSpeed(Number(e.target.value) / 100)}
          />
        </div>
      )}

      <div className="dm-style-row">
        <div className="dm-style-label-row">
          <span className="dm-style-label">关键词屏蔽</span>
          <span className="dm-style-val">{blockKeywords.length} 条</span>
        </div>
        <div className="dm-kw-input-row">
          <input
            className="text-input dm-kw-input"
            value={kwInput}
            placeholder="关键词或 /正则/"
            onChange={(e) => setKwInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddKeyword();
              }
            }}
          />
          <button
            type="button"
            className="dm-kw-add-btn"
            onClick={handleAddKeyword}
            title="添加屏蔽词"
          >
            <Plus size={12} />
          </button>
        </div>
        {blockKeywords.length > 0 && (
          <div className="dm-kw-tags">
            {blockKeywords.map((kw) => (
              <span key={kw} className="dm-kw-tag">
                <span>{kw}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveKeyword(kw)}
                  title={`移除「${kw}」`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
