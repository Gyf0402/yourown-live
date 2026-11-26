import { useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  AUTO_GROUP_VALUE,
  CHANNEL_PLATFORM_LIST,
  PLATFORM_LIST,
  formatWebUrlLabel,
  getChannelPlatformMeta,
  getFallbackGroup,
  getVisibleGroups,
  isLivePlatform,
  matchChannelGroup,
  parseLiveInput,
} from '../../shared/platforms';
import type {
  AuthStatusMap,
  Channel,
  ChannelPlatform,
  ChannelSortMode,
  LiveRoomStatus,
  PlatformId,
} from '../../shared/types';
import { ConfirmDialog } from './ConfirmDialog';

interface SidebarProps {
  channels: Channel[];
  customGroups: string[];
  hiddenDefaultGroups: string[];
  channelSortMode: ChannelSortMode;
  authStatus: AuthStatusMap;
  playingChannelIds: Set<string>;
  liveStatuses: Record<string, LiveRoomStatus>;
  checkingStatuses: boolean;
  onRefreshLiveStatuses: () => void;
  onAddChannel: (channel: Channel, openImmediately?: boolean) => void;
  onRemoveChannel: (id: string) => void;
  onTogglePin: (id: string) => void;
  onReorderChannels: (
    fromId: string,
    toId: string,
    position: 'before' | 'after'
  ) => void;
  onChangeChannelSortMode: (mode: ChannelSortMode) => void;
  onRenameChannel: (id: string, name: string, group?: string) => void;
  onAddGroup: (name: string) => void;
  onRemoveGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onRestoreDefaultGroups: () => void;
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
  hiddenDefaultGroups,
  channelSortMode,
  authStatus,
  playingChannelIds,
  liveStatuses,
  checkingStatuses,
  onRefreshLiveStatuses,
  onAddChannel,
  onRemoveChannel,
  onTogglePin,
  onReorderChannels,
  onChangeChannelSortMode,
  onRenameChannel,
  onAddGroup,
  onRemoveGroup,
  onRenameGroup,
  onRestoreDefaultGroups,
  onOpenChannel,
  onLoginPlatform,
  onOpenLoginModal,
}: SidebarProps) {
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null);
  const [rawInput, setRawInput] = useState('');
  const [customName, setCustomName] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<ChannelPlatform | 'auto'>('auto');
  const [selectedGroup, setSelectedGroup] = useState(AUTO_GROUP_VALUE);
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
  const [editingGroupTab, setEditingGroupTab] = useState<string | null>(null);
  const [editingGroupTabValue, setEditingGroupTabValue] = useState('');
  const [onlyLiveFilter, setOnlyLiveFilter] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);

  const liveChannelsTotal = useMemo(
    () => channels.filter((ch) => isLivePlatform(ch.platform)).length,
    [channels]
  );

  const liveCount = useMemo(
    () =>
      channels.filter((ch) => {
        if (!isLivePlatform(ch.platform)) return false;
        const st = liveStatuses[ch.id]?.status;
        return st === 'live' || st === 'replay';
      }).length,
    [channels, liveStatuses]
  );

  const groups = useMemo(
    () => getVisibleGroups(customGroups, hiddenDefaultGroups, channels),
    [channels, customGroups, hiddenDefaultGroups]
  );

  const selectableGroups = useMemo(() => groups.filter((g) => g !== '全部'), [groups]);
  const fallbackGroup = useMemo(() => getFallbackGroup(selectableGroups), [selectableGroups]);

  const filteredChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const indexMap = new Map<string, number>();
    channels.forEach((c, idx) => indexMap.set(c.id, idx));

    const ordered =
      channelSortMode === 'custom'
        ? [...channels]
        : [...channels].sort((a, b) => {
            if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
            const rankA =
              a.platform === 'web'
                ? 2
                : (STATUS_SORT_RANK[liveStatuses[a.id]?.status ?? 'unknown'] ?? 2);
            const rankB =
              b.platform === 'web'
                ? 2
                : (STATUS_SORT_RANK[liveStatuses[b.id]?.status ?? 'unknown'] ?? 2);
            if (rankA !== rankB) return rankA - rankB;
            return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
          });

    return ordered.filter((ch) => {
      if (activeGroupFilter !== '全部' && ch.group !== activeGroupFilter) return false;
      if (onlyLiveFilter) {
        if (ch.platform === 'web') {
          if (activeGroupFilter !== '网页') return false;
        } else {
          const st = liveStatuses[ch.id]?.status;
          if (st !== 'live' && st !== 'replay') return false;
        }
      }
      if (!q) return true;
      return (
        ch.name.toLowerCase().includes(q) ||
        ch.roomId.toLowerCase().includes(q) ||
        ch.url.toLowerCase().includes(q) ||
        getChannelPlatformMeta(ch.platform).name.includes(q) ||
        (liveStatuses[ch.id]?.title || '').toLowerCase().includes(q)
      );
    });
  }, [channels, channelSortMode, activeGroupFilter, searchQuery, liveStatuses, onlyLiveFilter]);

  const commitAdd = (
    platform: ChannelPlatform,
    roomId: string,
    url: string,
    suggestedName?: string,
    suggestedCategory?: string
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

    const meta = getChannelPlatformMeta(platform);
    const displayName =
      customName.trim() ||
      suggestedName ||
      (platform === 'web' ? formatWebUrlLabel(url) : `${meta.shortName} ${roomId}`);
    const isAutoGroup = selectedGroup === AUTO_GROUP_VALUE;
    const matchedGroup = isAutoGroup
      ? platform === 'web'
        ? selectableGroups.includes('网页')
          ? '网页'
          : fallbackGroup
        : matchChannelGroup(
            {
              category: suggestedCategory,
              anchorName: displayName,
              title: rawInput,
            },
            groups
          ) || fallbackGroup
      : selectedGroup || fallbackGroup;

    const newChannel: Channel = {
      id: `${platform}-${roomId}-${Date.now()}`,
      platform,
      roomId,
      name: displayName,
      group: matchedGroup,
      url,
      pinned: false,
      remarkLocked: Boolean(customName.trim()),
      groupLocked: !isAutoGroup,
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
    }
    setNewGroupName('');
    setAddingGroup(false);
  };

  const commitRenameGroupTab = () => {
    if (!editingGroupTab) return;
    const oldName = editingGroupTab;
    const nextName = editingGroupTabValue.trim().slice(0, 12);
    if (nextName && nextName !== '全部' && nextName !== oldName) {
      onRenameGroup(oldName, nextName);
      if (activeGroupFilter === oldName) setActiveGroupFilter(nextName);
      if (selectedGroup === oldName) setSelectedGroup(nextName);
    }
    setEditingGroupTab(null);
    setEditingGroupTabValue('');
  };

  const resolveAndCommitDouyu = async (raw: string, fallback?: ChannelPlatform) => {
    setResolving(true);
    setHint('正在解析斗鱼真实房间号...');
    try {
      const resolved = await window.livehub.resolveLiveInput(raw, fallback);
      if (resolved.ok && resolved.platform && resolved.roomId && resolved.url) {
        commitAdd(
          resolved.platform,
          resolved.roomId,
          resolved.url,
          resolved.suggestedName,
          resolved.suggestedCategory
        );
        return;
      }
      setHint(resolved.reason || '无法识别该斗鱼房间');
    } finally {
      setResolving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (resolving) return;
    const fallback = selectedPlatform === 'auto' ? undefined : selectedPlatform;
    const syncRes = parseLiveInput(rawInput, fallback);

    if (syncRes.ok) {
      // Resolve Douyu vanity short room IDs (e.g. 728 -> 12821) and fetch real nickname upfront
      if (syncRes.platform === 'douyu' && typeof window.livehub?.resolveLiveInput === 'function') {
        await resolveAndCommitDouyu(rawInput, fallback);
        return;
      }
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
            resolved.suggestedName,
            resolved.suggestedCategory
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
    if (platform === 'douyu' && typeof window.livehub?.resolveLiveInput === 'function') {
      void resolveAndCommitDouyu(pendingRoomId, 'douyu');
      return;
    }
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
            {CHANNEL_PLATFORM_LIST.map((p) => (
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
                title={
                  p.id === 'web'
                    ? '添加任意网页（抖音 / B站 / 小红书等，自动复用应用内登录 Cookie）'
                    : `指定添加 ${p.name} 房间号或链接`
                }
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
                  ? '粘贴直播间 / 任意网址 / 抖音口令'
                  : selectedPlatform === 'web'
                    ? '输入任意网址，如 douyin.com / bilibili.com'
                    : `输入${getChannelPlatformMeta(selectedPlatform).shortName}房间号或链接`
              }
            />
            <button
              type="submit"
              className="primary-btn"
              disabled={resolving}
              title="添加到收藏并打开"
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
              placeholder={
                selectedPlatform === 'web' ? '网站备注名（可选）' : '主播 / 网站备注名（可选）'
              }
            />
            <select
              className="select-input"
              value={
                selectedGroup === AUTO_GROUP_VALUE || selectableGroups.includes(selectedGroup)
                  ? selectedGroup
                  : AUTO_GROUP_VALUE
              }
              onChange={(e) => setSelectedGroup(e.target.value)}
              title="选择添加后的分组（选「自动分组」将按直播分区自动匹配已有分组）"
            >
              <option value={AUTO_GROUP_VALUE}>自动分组</option>
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
            const canEditOrDelete = g !== '全部';
            const isRenamingThis = editingGroupTab === g;
            if (isRenamingThis) {
              return (
                <input
                  key={g}
                  className="group-add-input"
                  value={editingGroupTabValue}
                  autoFocus
                  maxLength={12}
                  placeholder="分组名..."
                  onChange={(e) => setEditingGroupTabValue(e.target.value)}
                  onBlur={commitRenameGroupTab}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRenameGroupTab();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingGroupTab(null);
                      setEditingGroupTabValue('');
                    }
                  }}
                />
              );
            }
            return (
              <div
                key={g}
                className={`group-tab-wrap ${activeGroupFilter === g ? 'active' : ''}`}
              >
                <button
                  type="button"
                  className={`group-tab ${activeGroupFilter === g ? 'active' : ''} ${
                    canEditOrDelete ? 'has-close' : ''
                  }`}
                  onClick={() => setActiveGroupFilter(g)}
                  onDoubleClick={(e) => {
                    if (!canEditOrDelete) return;
                    e.stopPropagation();
                    setEditingGroupTab(g);
                    setEditingGroupTabValue(g);
                  }}
                  title={
                    canEditOrDelete
                      ? `单击筛选「${g}」，双击重命名分组，点 × 删除`
                      : '显示全部收藏主播'
                  }
                >
                  <span>{g}</span>
                  {canEditOrDelete && (
                    <span
                      className="group-tab-del"
                      role="button"
                      title={`删除分组「${g}」（该分组下主播将归入其他分组）`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDeleteGroup(g);
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
              title="新建自定义分组（新添加主播支持按分区自动匹配）"
            >
              <Plus size={11} />
            </button>
          )}

          {hiddenDefaultGroups.length > 0 && (
            <button
              type="button"
              className="group-tab group-add-btn"
              onClick={onRestoreDefaultGroups}
              title={`恢复已删除的预置分组（${hiddenDefaultGroups.join('、')}）`}
            >
              <RotateCcw size={10} />
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
              开播 {liveCount}/{liveChannelsTotal}
            </span>
            {onlyLiveFilter && <span className="live-filter-tag">仅开播</span>}
          </button>

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className={`sort-mode-btn ${channelSortMode === 'custom' ? 'active' : ''}`}
              onClick={() =>
                onChangeChannelSortMode(channelSortMode === 'custom' ? 'live' : 'custom')
              }
              title={
                channelSortMode === 'custom'
                  ? '当前：纯自定义顺序（无视开播状态，严格按拖拽位置固定；点击切回开播优先）'
                  : '当前：开播优先 + 同状态内按你的自定义拖拽顺序排（点击切纯自定义顺序）'
              }
            >
              <ArrowUpDown size={11} />
              <span>{channelSortMode === 'custom' ? '自定义' : '开播序'}</span>
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
      </div>

      <div className="channel-list">
        {filteredChannels.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {onlyLiveFilter
              ? '当前暂无开播中的收藏主播，点击上方按钮可查看全部'
              : '暂无匹配收藏，粘贴直播间或任意网址（抖音/B站等）即可加入'}
          </div>
        ) : (
          filteredChannels.map((channel, index) => {
            const meta = getChannelPlatformMeta(channel.platform);
            const isWeb = channel.platform === 'web';
            const isPlaying = playingChannelIds.has(channel.id);
            const isEditing = editingId === channel.id;
            const liveInfo = isWeb ? undefined : liveStatuses[channel.id];
            const liveState = isWeb ? 'unknown' : (liveInfo?.status ?? 'unknown');
            const isOffline = !isWeb && liveState === 'offline';

            const startEditing = () => {
              setEditingId(channel.id);
              setEditingValue(channel.name);
              setEditingGroup(channel.group || fallbackGroup);
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
                } ${draggingId === channel.id ? 'is-dragging' : ''} ${
                  dropTarget?.id === channel.id
                    ? dropTarget.pos === 'before'
                      ? 'drag-insert-before'
                      : 'drag-insert-after'
                    : ''
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
                  e.dataTransfer.setData('text/plain', channel.id);
                  e.dataTransfer.effectAllowed = 'copyMove';
                  setDraggingId(channel.id);
                }}
                onDragOver={(e) => {
                  if (!draggingId || draggingId === channel.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pos: 'before' | 'after' =
                    e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                  setDropTarget((cur) =>
                    cur && cur.id === channel.id && cur.pos === pos
                      ? cur
                      : { id: channel.id, pos }
                  );
                }}
                onDragLeave={() => {
                  setDropTarget((cur) => (cur?.id === channel.id ? null : cur));
                }}
                onDrop={(e) => {
                  if (!draggingId || draggingId === channel.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pos: 'before' | 'after' =
                    e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                  onReorderChannels(draggingId, channel.id, pos);
                  setDraggingId(null);
                  setDropTarget(null);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropTarget(null);
                }}
                onClick={() => {
                  if (!isEditing) onOpenChannel(channel);
                }}
                title={
                  isEditing
                    ? undefined
                    : liveInfo?.title && (liveState === 'live' || liveState === 'replay')
                      ? `${channel.name} — ${liveInfo.title}（点击播放，上下拖拽排序或拖到右侧分屏，双击改备注）`
                      : '点击播放，上下拖拽调整顺序或拖到右侧任意分屏，双击备注名可修改'
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
                        {!selectableGroups.includes(editingGroup) && editingGroup && (
                          <option value={editingGroup}>{editingGroup}</option>
                        )}
                        {selectableGroups.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                      {liveInfo?.category && liveInfo.category !== editingGroup && (
                        <button
                          type="button"
                          className="channel-auto-group-chip"
                          title={`自动识别直播分区为「${liveInfo.category}」，点击一键归入此分组`}
                          onClick={() => {
                            const suggested =
                              matchChannelGroup(
                                {
                                  category: liveInfo.category,
                                  title: liveInfo.title,
                                  anchorName: liveInfo.anchorName || channel.name,
                                },
                                groups
                              ) || liveInfo.category!.slice(0, 12);
                            setEditingGroup(suggested);
                          }}
                        >
                          <Sparkles size={10} />
                          <span>{liveInfo.category.slice(0, 8)}</span>
                        </button>
                      )}
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
                    <span className={isWeb ? 'channel-web-host' : undefined}>
                      {isWeb ? formatWebUrlLabel(channel.url) : `#${channel.roomId}`}
                    </span>
                    {!isWeb && liveInfo?.title && (liveState === 'live' || liveState === 'replay') ? (
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
                        <span>{isWeb ? '浏览中' : '播放中'}</span>
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

      {pendingDeleteGroup && (() => {
        const g = pendingDeleteGroup;
        const count = channels.filter((c) => c.group === g).length;
        return (
          <ConfirmDialog
            danger
            title={`删除分组「${g}」？`}
            description={
              count > 0 ? (
                <>
                  该分组下的 <strong>{count}</strong> 位主播将自动归入其他分组，主播本身不会被删除。
                </>
              ) : (
                '该分组下暂无主播，删除后不可恢复。'
              )
            }
            confirmText="删除分组"
            onCancel={() => setPendingDeleteGroup(null)}
            onConfirm={() => {
              setPendingDeleteGroup(null);
              onRemoveGroup(g);
              if (activeGroupFilter === g) setActiveGroupFilter('全部');
              if (selectedGroup === g) setSelectedGroup(AUTO_GROUP_VALUE);
            }}
          />
        );
      })()}
    </aside>
  );
}
