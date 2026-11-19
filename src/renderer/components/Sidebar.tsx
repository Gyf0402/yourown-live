import { useMemo, useState } from 'react';
import {
  Check,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_GROUPS,
  PLATFORM_LIST,
  PLATFORMS,
  parseLiveInput,
} from '../../shared/platforms';
import type {
  AuthStatusMap,
  Channel,
  LiveRoomStatus,
  PlatformId,
} from '../../shared/types';

interface SidebarProps {
  channels: Channel[];
  customGroups: string[];
  authStatus: AuthStatusMap;
  playingChannelIds: Set<string>;
  liveStatuses: Record<string, LiveRoomStatus>;
  checkingStatuses: boolean;
  onRefreshLiveStatuses: () => void;
  onAddChannel: (channel: Channel, openImmediately?: boolean) => void;
  onRemoveChannel: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRenameChannel: (id: string, name: string, group?: string) => void;
  onAddGroup: (name: string) => void;
  onRemoveGroup: (name: string) => void;
  onOpenChannel: (channel: Channel) => void;
  onLoginPlatform: (platform: PlatformId) => void;
  onOpenLoginModal: () => void;
}

const STATUS_SORT_RANK: Record<string, number> = {
  live: 0,
  replay: 1,
  unknown: 2,
  offline: 3,
};

export function Sidebar({
  channels,
  customGroups,
  authStatus,
  playingChannelIds,
  liveStatuses,
  checkingStatuses,
  onRefreshLiveStatuses,
  onAddChannel,
  onRemoveChannel,
  onTogglePin,
  onRenameChannel,
  onAddGroup,
  onRemoveGroup,
  onOpenChannel,
  onLoginPlatform,
  onOpenLoginModal,
}: SidebarProps) {
  const [rawInput, setRawInput] = useState('');
  const [customName, setCustomName] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId | 'auto'>('auto');
  const [selectedGroup, setSelectedGroup] = useState('综合');
  const [activeGroupFilter, setActiveGroupFilter] = useState('全部');
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingGroup, setEditingGroup] = useState('综合');
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [onlyLiveFilter, setOnlyLiveFilter] = useState(false);

  const liveCount = useMemo(
    () =>
      channels.filter((ch) => {
        const st = liveStatuses[ch.id]?.status;
        return st === 'live' || st === 'replay';
      }).length,
    [channels, liveStatuses]
  );

  const groups = useMemo(() => {
    const set = new Set<string>(DEFAULT_GROUPS);
    customGroups.forEach((g) => {
      if (g && g !== '全部') set.add(g);
    });
    channels.forEach((ch) => {
      if (ch.group) set.add(ch.group);
    });
    return Array.from(set);
  }, [channels, customGroups]);

  const selectableGroups = useMemo(() => groups.filter((g) => g !== '全部'), [groups]);
  const defaultGroupSet = useMemo(() => new Set<string>(DEFAULT_GROUPS), []);

  const filteredChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...channels]
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        const rankA = STATUS_SORT_RANK[liveStatuses[a.id]?.status ?? 'unknown'] ?? 2;
        const rankB = STATUS_SORT_RANK[liveStatuses[b.id]?.status ?? 'unknown'] ?? 2;
        if (rankA !== rankB) return rankA - rankB;
        return b.createdAt - a.createdAt;
      })
      .filter((ch) => {
        if (activeGroupFilter !== '全部' && ch.group !== activeGroupFilter) return false;
        if (onlyLiveFilter) {
          const st = liveStatuses[ch.id]?.status;
          if (st !== 'live' && st !== 'replay') return false;
        }
        if (!q) return true;
        return (
          ch.name.toLowerCase().includes(q) ||
          ch.roomId.toLowerCase().includes(q) ||
          PLATFORMS[ch.platform].name.includes(q) ||
          (liveStatuses[ch.id]?.title || '').toLowerCase().includes(q)
        );
      });
  }, [channels, activeGroupFilter, searchQuery, liveStatuses, onlyLiveFilter]);

  const commitAdd = (
    platform: PlatformId,
    roomId: string,
    url: string,
    suggestedName?: string
  ) => {
    const existing = channels.find(
      (c) => c.platform === platform && c.roomId.toLowerCase() === roomId.toLowerCase()
    );
    if (existing) {
      onOpenChannel(existing);
      setRawInput('');
      setCustomName('');
      setPendingRoomId(null);
      setHint(`「${existing.name}」已在收藏中，已为你直接打开`);
      return;
    }

    const meta = PLATFORMS[platform];
    const displayName =
      customName.trim() || suggestedName || `${meta.shortName} ${roomId}`;
    const newChannel: Channel = {
      id: `${platform}-${roomId}-${Date.now()}`,
      platform,
      roomId,
      name: displayName,
      group: selectedGroup || '综合',
      url,
      pinned: false,
      remarkLocked: Boolean(customName.trim()),
      createdAt: Date.now(),
    };
    onAddChannel(newChannel, true);
    setRawInput('');
    setCustomName('');
    setPendingRoomId(null);
    setHint(null);
  };

  const commitNewGroup = () => {
    const name = newGroupName.trim().slice(0, 12);
    if (name && name !== '全部') {
      onAddGroup(name);
      setActiveGroupFilter(name);
      setSelectedGroup(name);
    }
    setNewGroupName('');
    setAddingGroup(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (resolving) return;
    const fallback = selectedPlatform === 'auto' ? undefined : selectedPlatform;
    const syncRes = parseLiveInput(rawInput, fallback);

    if (syncRes.ok) {
      commitAdd(syncRes.platform, syncRes.roomId, syncRes.url, syncRes.suggestedName);
      return;
    }

    if (syncRes.needsShortResolve && window.livehub?.resolveLiveInput) {
      setResolving(true);
      setHint(syncRes.reason);
      try {
        const resolved = await window.livehub.resolveLiveInput(rawInput, fallback);
        if (resolved.ok && resolved.platform && resolved.roomId && resolved.url) {
          commitAdd(
            resolved.platform,
            resolved.roomId,
            resolved.url,
            resolved.suggestedName
          );
          return;
        }
        if (resolved.needsPlatform && resolved.roomId) {
          setPendingRoomId(resolved.roomId);
          setHint(resolved.reason || '请选择所属平台');
          return;
        }
        setPendingRoomId(null);
        setHint(resolved.reason || '无法识别该链接');
      } finally {
        setResolving(false);
      }
      return;
    }

    if (syncRes.needsPlatform && syncRes.roomId) {
      setPendingRoomId(syncRes.roomId);
      setHint(syncRes.reason);
      return;
    }
    setPendingRoomId(null);
    setHint(syncRes.reason);
  };

  const handlePickPlatform = (platform: PlatformId) => {
    if (!pendingRoomId) return;
    const res = parseLiveInput(pendingRoomId, platform);
    if (res.ok) {
      commitAdd(res.platform, res.roomId, res.url, res.suggestedName);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <form className="add-form" onSubmit={(e) => void handleSubmit(e)}>
          <div className="platform-mode-row">
            <button
              type="button"
              className={`platform-mode-pill ${selectedPlatform === 'auto' ? 'active' : ''}`}
              onClick={() => setSelectedPlatform('auto')}
            >
              自动
            </button>
            {PLATFORM_LIST.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`platform-mode-pill ${selectedPlatform === p.id ? 'active' : ''}`}
                style={
                  selectedPlatform === p.id
                    ? { color: p.color, borderColor: p.color, background: p.bgTint }
                    : undefined
                }
                onClick={() => setSelectedPlatform(p.id)}
                title={`指定添加 ${p.name} 房间号或链接`}
              >
                {p.shortName}
              </button>
            ))}
          </div>

          <div className="input-row">
            <input
              className="text-input"
              value={rawInput}
              onChange={(e) => {
                setRawInput(e.target.value);
                setPendingRoomId(null);
                setHint(null);
              }}
              placeholder={
                selectedPlatform === 'auto'
                  ? '粘贴链接/抖音口令/分享短链'
                  : `输入${PLATFORMS[selectedPlatform].shortName}房间号或链接`
              }
            />
            <button
              type="submit"
              className="primary-btn"
              disabled={resolving}
              title="添加到收藏并播放"
            >
              <Plus size={14} />
              <span>{resolving ? '解析中' : '添加'}</span>
            </button>
          </div>

          <div className="input-row">
            <input
              className="text-input"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="主播备注名（可选）"
            />
            <select
              className="select-input"
              value={selectedGroup}
              onChange={(e) => setSelectedGroup(e.target.value)}
            >
              {selectableGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          {pendingRoomId && (
            <div className="platform-picker">
              {PLATFORM_LIST.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="platform-chip"
                  style={{ color: p.color, background: p.bgTint, borderColor: p.color }}
                  onClick={() => handlePickPlatform(p.id)}
                >
                  {p.shortName}
                </button>
              ))}
            </div>
          )}

          {hint && <div className="form-hint">{hint}</div>}
        </form>
      </div>

      <div className="sidebar-section">
        <div className="input-row" style={{ alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
            <Search
              size={13}
              style={{ position: 'absolute', left: 9, color: 'var(--text-muted)', pointerEvents: 'none' }}
            />
            <input
              className="text-input"
              style={{ paddingLeft: 28, height: 29 }}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="筛选主播 / 房间号..."
            />
          </div>
        </div>

        <div className="group-tabs">
          {groups.map((g) => {
            const isCustom = !defaultGroupSet.has(g);
            return (
              <div
                key={g}
                className={`group-tab-wrap ${activeGroupFilter === g ? 'active' : ''}`}
              >
                <button
                  className={`group-tab ${activeGroupFilter === g ? 'active' : ''} ${
                    isCustom ? 'has-close' : ''
                  }`}
                  onClick={() => setActiveGroupFilter(g)}
                >
                  <span>{g}</span>
                  {isCustom && (
                    <span
                      className="group-tab-del"
                      role="button"
                      title={`删除自定义分组「${g}」（主播将归入综合）`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveGroup(g);
                        if (activeGroupFilter === g) setActiveGroupFilter('全部');
                        if (selectedGroup === g) setSelectedGroup('综合');
                      }}
                    >
                      <X size={10} />
                    </span>
                  )}
                </button>
              </div>
            );
          })}

          {addingGroup ? (
            <input
              className="group-add-input"
              value={newGroupName}
              autoFocus
              maxLength={12}
              placeholder="新分组..."
              onChange={(e) => setNewGroupName(e.target.value)}
              onBlur={commitNewGroup}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitNewGroup();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setNewGroupName('');
                  setAddingGroup(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="group-tab group-add-btn"
              onClick={() => setAddingGroup(true)}
              title="新建自定义分组"
            >
              <Plus size={11} />
            </button>
          )}
        </div>

        <div className="live-status-bar">
          <button
            type="button"
            className={`live-filter-pill ${onlyLiveFilter ? 'active' : ''}`}
            onClick={() => setOnlyLiveFilter((v) => !v)}
            title={onlyLiveFilter ? '当前仅显示开播/轮播主播，点击查看全部' : '点击仅看当前开播主播'}
          >
            <span className={`live-dot ${liveCount > 0 ? 'live' : 'offline'}`} />
            <span>
              开播 {liveCount}/{channels.length}
            </span>
            {onlyLiveFilter && <span className="live-filter-tag">仅开播</span>}
          </button>

          <button
            type="button"
            className={`status-refresh-btn ${checkingStatuses ? 'spinning' : ''}`}
            onClick={onRefreshLiveStatuses}
            disabled={checkingStatuses}
            title="立即重新检测全部直播间开播状态"
          >
            <RefreshCw size={12} />
            <span>{checkingStatuses ? '检测中' : '测开播'}</span>
          </button>
        </div>
      </div>

      <div className="channel-list">
        {filteredChannels.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {onlyLiveFilter
              ? '当前暂无开播中的收藏主播，点击上方按钮可查看全部'
              : '暂无匹配主播，粘贴虎牙 / 斗鱼 / B站 / 抖音链接即可加入'}
          </div>
        ) : (
          filteredChannels.map((channel, index) => {
            const meta = PLATFORMS[channel.platform];
            const isPlaying = playingChannelIds.has(channel.id);
            const isEditing = editingId === channel.id;
            const liveInfo = liveStatuses[channel.id];
            const liveState = liveInfo?.status ?? 'unknown';
            const isOffline = liveState === 'offline';

            const startEditing = () => {
              setEditingId(channel.id);
              setEditingValue(channel.name);
              setEditingGroup(channel.group || '综合');
            };

            const saveEditing = () => {
              const trimmed = editingValue.trim();
              if (trimmed && (trimmed !== channel.name || editingGroup !== channel.group)) {
                onRenameChannel(channel.id, trimmed, editingGroup);
              }
              setEditingId(null);
            };

            const cancelEditing = () => {
              setEditingId(null);
            };

            return (
              <div
                key={channel.id}
                className={`channel-card ${isPlaying ? 'playing' : ''} ${
                  isOffline && !isPlaying ? 'is-offline' : ''
                }`}
                style={{ '--stagger': `${Math.min(index, 10) * 32}ms` } as React.CSSProperties}
                draggable={!isEditing}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = ((e.clientX - rect.left) / rect.width) * 100;
                  const y = ((e.clientY - rect.top) / rect.height) * 100;
                  e.currentTarget.style.setProperty('--mx', `${x.toFixed(1)}%`);
                  e.currentTarget.style.setProperty('--my', `${y.toFixed(1)}%`);
                }}
                onDragStart={(e) => {
                  if (isEditing) return;
                  e.dataTransfer.setData(
                    'application/x-livehub-channel',
                    JSON.stringify(channel)
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => {
                  if (!isEditing) onOpenChannel(channel);
                }}
                title={
                  isEditing
                    ? undefined
                    : liveInfo?.title && (liveState === 'live' || liveState === 'replay')
                      ? `${channel.name} — ${liveInfo.title}（点击播放，双击备注可修改）`
                      : '点击打开或拖拽到任意分屏，双击备注名可修改'
                }
              >
                <span
                  className="platform-badge"
                  style={{ color: meta.color, background: meta.bgTint }}
                >
                  {meta.shortName}
                </span>

                <div className="channel-info">
                  {isEditing ? (
                    <div className="channel-edit-row" onClick={(e) => e.stopPropagation()}>
                      <input
                        className="channel-rename-input"
                        value={editingValue}
                        autoFocus
                        placeholder="输入直播间备注"
                        onChange={(e) => setEditingValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            saveEditing();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEditing();
                          }
                        }}
                      />
                      <select
                        className="channel-group-select"
                        value={editingGroup}
                        onChange={(e) => setEditingGroup(e.target.value)}
                        title="修改所属分组"
                      >
                        {selectableGroups.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="channel-name-row">
                      <div
                        className="channel-name"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startEditing();
                        }}
                      >
                        {channel.name}
                      </div>
                      {liveState === 'live' && (
                        <span className="live-status-pill live">
                          <span className="live-dot live" />
                          直播中
                        </span>
                      )}
                      {liveState === 'replay' && (
                        <span className="live-status-pill replay">
                          <span className="live-dot replay" />
                          轮播
                        </span>
                      )}
                      {liveState === 'offline' && (
                        <span className="live-status-pill offline">未开播</span>
                      )}
                    </div>
                  )}
                  <div className="channel-sub">
                    <span>#{channel.roomId}</span>
                    {liveInfo?.title && (liveState === 'live' || liveState === 'replay') ? (
                      <>
                        <span>·</span>
                        <span className="channel-live-title">{liveInfo.title}</span>
                      </>
                    ) : (
                      <>
                        <span>·</span>
                        <span>{channel.group}</span>
                      </>
                    )}
                    {isPlaying && (
                      <span className="playing-eq-tag">
                        <span className="eq-bars" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span>播放中</span>
                      </span>
                    )}
                  </div>
                </div>

                <div
                  className={`channel-actions ${channel.pinned || isEditing ? 'always' : ''} ${
                    isEditing ? 'editing' : ''
                  }`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {isEditing ? (
                    <>
                      <button
                        className="mini-btn"
                        style={{ color: 'var(--success)' }}
                        title="保存备注 (Enter)"
                        onClick={saveEditing}
                      >
                        <Check size={12} />
                      </button>
                      <button
                        className="mini-btn"
                        title="取消 (Esc)"
                        onClick={cancelEditing}
                      >
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="mini-btn"
                        title="播放"
                        onClick={() => onOpenChannel(channel)}
                      >
                        <Play size={12} />
                      </button>
                      <button
                        className="mini-btn"
                        title="修改备注"
                        onClick={startEditing}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        className={`mini-btn ${channel.pinned ? 'pinned' : ''}`}
                        title={channel.pinned ? '取消置顶' : '置顶收藏'}
                        onClick={() => onTogglePin(channel.id)}
                      >
                        <Star size={12} fill={channel.pinned ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        className="mini-btn danger"
                        title="移除"
                        onClick={() => onRemoveChannel(channel.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="sidebar-auth-footer">
        <div className="sidebar-auth-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <KeyRound size={12} />
            <span>账号登录（解锁高画质）</span>
          </span>
          <button
            style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 500 }}
            onClick={onOpenLoginModal}
          >
            管理
          </button>
        </div>

        <div className="sidebar-auth-grid">
          {PLATFORM_LIST.map((p) => {
            const info = authStatus[p.id];
            return (
              <button
                key={p.id}
                className={`sidebar-auth-pill ${info?.loggedIn ? 'logged-in' : ''}`}
                onClick={() => onLoginPlatform(p.id)}
                title={
                  info?.loggedIn
                    ? `${p.name} 已登录（${info.accountHint || 'Cookie 已生效'}），点击可管理或切换账号`
                    : `点击打开 ${p.name} 登录窗口，解锁蓝光/原画`
                }
              >
                <span style={{ color: p.color, fontWeight: 600 }}>{p.shortName}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: info?.loggedIn ? 'var(--success)' : 'var(--text-muted)' }}>
                  <span className={`auth-dot ${info?.loggedIn ? 'online' : ''}`} />
                  {info?.loggedIn ? '已登' : '登录'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
