import { ipcRenderer, webFrame } from 'electron';
import type {
  PlatformId,
  StreamOptionItem,
  StreamOptionsInfo,
  WebviewPurifyConfig,
} from '../shared/types';

let currentConfig: WebviewPurifyConfig = {
  mode: 'pure',
  autoHighestQuality: true,
  hideGiftEffects: true,
  danmakuEnabled: true,
};

let lastQualityUrl = '';
let lastProbedUrl = '';
let lastEmittedJson = '';

function detectPlatform(): PlatformId | null {
  const host = window.location.hostname.toLowerCase();
  if (host.includes('huya.com')) return 'huya';
  if (host.includes('douyu.com')) return 'douyu';
  if (host.includes('bilibili.com')) return 'bilibili';
  if (host.includes('douyin.com')) return 'douyin';
  return null;
}

const PURIFY_CSS = `
/* Universal Pure Mode Player Root */
html[data-livehub-pure="1"],
html[data-livehub-pure="1"] body {
  overflow: hidden !important;
  background: #000 !important;
  margin: 0 !important;
  padding: 0 !important;
}

html[data-livehub-pure="1"] [data-livehub-player-root="1"] {
  position: fixed !important;
  inset: 0 !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: none !important;
  max-height: none !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  z-index: 9999 !important;
  background: #000 !important;
  border: none !important;
}

html[data-livehub-pure="1"] [data-livehub-player-root="1"] video {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
}

/* ---------------- HUYA (AdBlock + Pure) ---------------- */
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .room-player-plugin,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .MeowPlayer-Booth,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .player-face-recommend-wrap,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .room-sidebar-ad,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .hy-ad-banner,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] div[id^="plat_"],
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .ab-box,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .ab-wrap,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .player-ad-wrap,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] #player-ad-wrap,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .banner-ad,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] #hy-nav-download,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .room-mod-gg,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .player-download-guide,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .download-client-tip,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .diy-activity-icon,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .player-subscribe-guide,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] #player-pc-watch-tip,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] .watch-client-tip,
html[data-livehub-adblock="1"][data-livehub-platform="huya"] [class*="ad-banner"],
html[data-livehub-adblock="1"][data-livehub-platform="huya"] [class*="adBanner"],
html[data-livehub-pure="1"][data-livehub-platform="huya"] #duya-header,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .mod-sidebar,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .sidebar-min-wrap,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .room-sidebar,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .room-core-r,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .room-hd,
html[data-livehub-pure="1"][data-livehub-platform="huya"] #J_roomHd,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .room-footer,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .live-recommend,
html[data-livehub-pure="1"][data-livehub-platform="huya"] #player-login-tip-wrap,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .login-tip-wrap {
  display: none !important;
}

html[data-livehub-pure="1"][data-livehub-platform="huya"] #videoContainer #player-wrap {
  width: 100% !important;
  height: 100% !important;
}

/* Hide Huya bottom control/progress bar in pure mode without unmounting quality/line DOM nodes */
html[data-livehub-pure="1"][data-livehub-platform="huya"] #player-ctrl-wrap,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .player-ctrl-wrap,
html[data-livehub-pure="1"][data-livehub-platform="huya"] #J_playerCtrlWrap,
html[data-livehub-pure="1"][data-livehub-platform="huya"] #player-progress-wrap,
html[data-livehub-pure="1"][data-livehub-platform="huya"] .player-progress-wrap {
  opacity: 0 !important;
  pointer-events: none !important;
  height: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
  transform: translateY(120px) !important;
}

html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] #player-gift-wrap,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] .player-gift-wrap,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] .gift-show-box,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] #player-marquee-wrap,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] .player-banner-gift,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] .week-star-rank,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="huya"] .pk-progress-wrap {
  display: none !important;
}

html[data-livehub-danmaku="0"][data-livehub-platform="huya"] #danmuwrap,
html[data-livehub-danmaku="0"][data-livehub-platform="huya"] .danmu-wrap,
html[data-livehub-danmaku="0"][data-livehub-platform="huya"] .player-danmu-wrap {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ---------------- DOUYU (AdBlock + Pure) ---------------- */
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .LotteryContainer,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .UPlayerLotteryEnter,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .UPlayerLotteryEnter-giftImg,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .PaladinWeek-toast,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .Activites-icon,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .ChargeGuide,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] ._sign-in-guide,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .Topic-ad,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .live-room-normal-flash-banner,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .MatchCard-bg,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .room-top-banner,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .head-ad,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .ad-box,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] div[class^="Ad-"],
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] div[class*="AdBanner"],
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] #__hyad,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .layout-Player-guessgame,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .GuessGameMiniPanel,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .SignInBox,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .DownloadGuide,
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] [class*="downloadGuide"],
html[data-livehub-adblock="1"][data-livehub-platform="douyu"] .ZoomTip,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .layout-Header,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .layout-Aside,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .layout-Player-aside,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .layout-Player-title,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .layout-Player-toolbar,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .layout-Bottom,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] #js-bottom-list,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .SysSignIn,
html[data-livehub-pure="1"][data-livehub-platform="douyu"] .PlayerToolbar {
  display: none !important;
}

html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyu"] .Barrage-topFloater,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyu"] .ScreenBanner,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyu"] .Treasure,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyu"] [class*="GiftEffect"],
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyu"] [class*="pk-"],
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyu"] .FansMedalPanel {
  display: none !important;
}

html[data-livehub-danmaku="0"][data-livehub-platform="douyu"] [class*="danmu-"],
html[data-livehub-danmaku="0"][data-livehub-platform="douyu"] [class*="comment-"] canvas {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ---------------- BILIBILI (AdBlock + Pure) ---------------- */
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .web-live-room-qa-pop,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .ads-panel,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .app-download-sidebar,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .link-navbar-recommend,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .web-game-icon,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .link-top-banner,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .pendant-item,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .pendant-ctnr,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .activity-banner,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .act-entry,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .anchor-task-ctnr,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .shop-popover,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .vip-guide-tip,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .download-client-entry,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .right-bottom-operator-row,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] .lottery-box,
html[data-livehub-adblock="1"][data-livehub-platform="bilibili"] [class*="ad-banner"],
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] #link-navbar-vm,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .link-navbar-ctnr,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .side-bar-cntr,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] #aside-area-vm,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] #rank-list-vm,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] #gift-control-vm,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .room-info-ctnr,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .lower-row,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .bottom-theme-ctnr,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .live-harass-vm,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .web-player-ending-panel,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .follow-guide-panel,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] .login-tip-banner,
html[data-livehub-pure="1"][data-livehub-platform="bilibili"] #sections-vm {
  display: none !important;
}

html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="bilibili"] .gift-animation-panel,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="bilibili"] .bili-live-player-video-gift,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="bilibili"] .combo-card-item,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="bilibili"] .super-chat-card-list,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="bilibili"] .special-gift-container,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="bilibili"] .pk-live-player-ctnr {
  display: none !important;
}

html[data-livehub-danmaku="0"][data-livehub-platform="bilibili"] .bilibili-live-player-video-danmaku,
html[data-livehub-danmaku="0"][data-livehub-platform="bilibili"] .web-player-danmaku {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ---------------- DOUYIN (AdBlock + Pure) ---------------- */
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [data-e2e="feed-item"] [data-e2e="ad-link"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [data-e2e="feed-item"] [aria-label*="广告"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [data-e2e="download-guide"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] div[class*="Download"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [class*="activity-banner"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [class*="RedPacket"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [class*="red-packet"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [class*="ec-card"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [class*="shopping-card"],
html[data-livehub-adblock="1"][data-livehub-platform="douyin"] [class*="yellow-cart"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] body,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] #root,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="living-container"] {
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  overflow: hidden !important;
}

html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-livehub-player-root="1"] video {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  margin: auto !important;
  transform: none !important;
  object-fit: contain !important;
}

html[data-livehub-pure="1"][data-livehub-platform="douyin"] #douyin-header,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] #douyin-sidebar,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="douyin-navigation"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="live-room-aside"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] #HeaderLayout,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] #room_info_bar,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="fullscreen-back"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="live-followbutton"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="live-room-audience"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="gifts-container"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] #giftPanelEntrance,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="gifts-switch"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [data-e2e="recharge-btn"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] .gift_item_gift_bar,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] .douyin_login_iframe,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] div[id^="login-full-panel-"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [id^="related-video-card-login-guide"],
html[data-livehub-pure="1"][data-livehub-platform="douyin"] [class*="recommend-container"] {
  display: none !important;
}

/* Visually hide Douyin bottom control bar in pure mode while preserving quality/line DOM controls */
html[data-livehub-pure="1"][data-livehub-platform="douyin"] .douyin-player-controls,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] xg-controls,
html[data-livehub-pure="1"][data-livehub-platform="douyin"] .xgplayer-controls {
  opacity: 0 !important;
  pointer-events: none !important;
  height: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  transform: translateY(120px) !important;
}

html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyin"] [data-e2e="gift-effect-container"],
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyin"] [data-e2e="gifts-container"],
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyin"] .xgplayer-gift-effect,
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyin"] [class*="gift-container"],
html[data-livehub-pure="1"][data-livehub-hide-gifts="1"][data-livehub-platform="douyin"] [class*="pk-container"] {
  display: none !important;
}

html[data-livehub-danmaku="0"][data-livehub-platform="douyin"] xg-danmu,
html[data-livehub-danmaku="0"][data-livehub-platform="douyin"] .xgplayer-danmu {
  opacity: 0 !important;
  pointer-events: none !important;
}
`;

const QUALITY_KW = /原画|蓝光|真彩|杜比|4K|2K|1080|720|超清|高清|标清|流畅|极速|自动|高帧率/i;
const LINE_KW = /线路|主线|备线|默认线路|CDN|节点|电信|联通|移动|腾讯|阿里|华为|网宿|火山|BVC|MCDN/i;
const ACTIVE_CLASS_TOKENS = new Set(['on', 'active', 'selected', 'current', 'checked', 'cur']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function cleanText(raw: string | null | undefined): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

function simulateHover(el: Element, enter: boolean): void {
  const events = enter ? ['mouseenter', 'mouseover'] : ['mouseleave', 'mouseout'];
  for (const type of events) {
    el.dispatchEvent(
      new MouseEvent(type, {
        view: el.ownerDocument?.defaultView || window,
        bubbles: true,
        cancelable: true,
      })
    );
  }
}

function simulateClick(el: HTMLElement): void {
  const parentUl = el.closest('ul');
  const prevDisplay = parentUl ? parentUl.style.display : '';
  const wasHidden = parentUl && window.getComputedStyle(parentUl).display === 'none';
  if (parentUl && wasHidden) {
    parentUl.style.display = 'block';
  }

  try {
    el.click();
    const view = el.ownerDocument?.defaultView || window;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(
        new MouseEvent(type, {
          view,
          bubbles: true,
          cancelable: true,
          buttons: 1,
        })
      );
    }
    const innerSpan = el.querySelector<HTMLElement>('span, a, button');
    if (innerSpan) {
      innerSpan.click();
    }
  } finally {
    if (parentUl && wasHidden) {
      window.setTimeout(() => {
        parentUl.style.display = prevDisplay;
      }, 60);
    }
  }
}

function isElementActive(el: HTMLElement, currentTriggerText?: string): boolean {
  const tokens = String(el.className || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (
    tokens.some(
      (tok) =>
        ACTIVE_CLASS_TOKENS.has(tok) ||
        /(^|[-_])(active|selected|current|checked)($|[-_])/.test(tok)
    ) ||
    el.getAttribute('aria-checked') === 'true' ||
    el.getAttribute('aria-selected') === 'true' ||
    el.getAttribute('data-selected') === 'true'
  ) {
    return true;
  }

  const label = cleanText(el.textContent);
  if (currentTriggerText && label && currentTriggerText === label) {
    return true;
  }
  return false;
}

function isOptionLocked(el: HTMLElement): boolean {
  const tokens = String(el.className || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const txt = cleanText(el.textContent);
  return (
    tokens.some((t) => t.includes('disabled') || t.includes('lock')) ||
    /请先登录|登录|扫码|vip|付费|专享/i.test(txt)
  );
}

/**
 * Find the document containing the actual live player (handles Bilibili blanc iframe).
 */
function getPlayerDocuments(): Document[] {
  const docs: Document[] = [document];
  const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
  for (const frame of iframes) {
    try {
      const fDoc = frame.contentDocument;
      if (fDoc && fDoc.documentElement) {
        docs.push(fDoc);
      }
    } catch {
      // Cross-origin iframe; ignore safely
    }
  }
  return docs;
}

function getSearchScopes(): ParentNode[] {
  const scopes: ParentNode[] = [];
  for (const doc of getPlayerDocuments()) {
    const root = doc.querySelector('[data-livehub-player-root="1"]');
    if (root) scopes.push(root);
    if (doc.body) scopes.push(doc.body);
  }
  return scopes;
}

function findQualityTrigger(scopes: ParentNode[]): HTMLElement | null {
  const selectors = [
    '.player-videotype-cur',
    '.player-videotype',
    '.quality-wrap',
    '.xgplayer-definition',
    '[data-e2e="quality-btn"]',
    '[class*="rate-"]',
    '[class*="quality"]',
  ];
  for (const scope of scopes) {
    for (const sel of selectors) {
      const el = scope.querySelector<HTMLElement>(sel);
      if (el && cleanText(el.textContent).length <= 28) return el;
    }
  }
  for (const scope of scopes) {
    const candidates = Array.from(
      scope.querySelectorAll<HTMLElement>('button, [role="button"], span, div')
    );
    const hit = candidates.find((el) => {
      if (el.children.length > 3) return false;
      const t = cleanText(el.textContent);
      return t.length > 0 && t.length <= 16 && /^(原画|蓝光|超清|高清|流畅|清晰度|画质|自动)/.test(t);
    });
    if (hit) return hit;
  }
  return null;
}

function findLineTrigger(scopes: ParentNode[]): HTMLElement | null {
  const selectors = [
    '.player-videoline-cur',
    '.player-videoline',
    '.player-line-btn',
    '.player-cdn-btn',
    '#player-line-btn',
    '.xgplayer-line',
    '[class*="line-btn"]',
    '[class*="cdn"]',
    '[class*="lineSwitch"]',
  ];
  for (const scope of scopes) {
    for (const sel of selectors) {
      const el = scope.querySelector<HTMLElement>(sel);
      if (el && cleanText(el.textContent).length <= 28) return el;
    }
  }
  for (const scope of scopes) {
    const candidates = Array.from(
      scope.querySelectorAll<HTMLElement>('button, [role="button"], span, div')
    );
    const hit = candidates.find((el) => {
      if (el.children.length > 3) return false;
      const t = cleanText(el.textContent);
      return t.length > 0 && t.length <= 16 && /^(线路|主线|备线|CDN|默认线路)/i.test(t);
    });
    if (hit) return hit;
  }
  return null;
}

interface DiscoveredGroup {
  items: { el: HTMLElement | null; option: StreamOptionItem }[];
  source: 'dom' | 'bili-api';
}

function extractGroupBySelectors(
  scopes: ParentNode[],
  selectors: string[],
  triggerText?: string
): DiscoveredGroup | null {
  for (const scope of scopes) {
    for (const sel of selectors) {
      const nodes = Array.from(scope.querySelectorAll<HTMLElement>(sel)).filter((el) => {
        const t = cleanText(el.textContent);
        return t.length > 0 && t.length <= 28;
      });
      if (nodes.length >= 2) {
        const seen = new Set<string>();
        const items: { el: HTMLElement; option: StreamOptionItem }[] = [];
        nodes.forEach((el, idx) => {
          const label = cleanText(el.textContent);
          if (!label || seen.has(label)) return;
          seen.add(label);
          items.push({
            el,
            option: {
              id: `${idx}:${label}`,
              label,
              active: isElementActive(el, triggerText),
              locked: isOptionLocked(el),
            },
          });
        });
        if (items.length >= 2) return { items, source: 'dom' };
      }
    }
  }
  return null;
}

function extractGroupHeuristically(
  scopes: ParentNode[],
  keywordPattern: RegExp,
  oppositePattern: RegExp,
  triggerText?: string
): DiscoveredGroup | null {
  // Only scan player root if available (avoid scanning thousands of page-wide divs)
  const effectiveScopes = scopes.length > 1 ? [scopes[0]] : scopes;
  const orderedSelectors = ['ul', '[role="menu"]', '[class*="menu"]', '[class*="list"]', '[class*="panel"]'];
  for (const scope of effectiveScopes) {
    for (const sel of orderedSelectors) {
      const containers = Array.from(scope.querySelectorAll<HTMLElement>(sel));
      for (const container of containers) {
        const children = Array.from(container.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement
        );
        if (children.length < 2 || children.length > 14) continue;
        // Never treat a parent wrapper containing nested lists or complex widgets as an option list
        if (
          children.some(
            (c) => Boolean(c.querySelector('ul, li')) || c.querySelectorAll('*').length > 4
          )
        ) {
          continue;
        }
        const firstTag = children[0].tagName;
        if (!children.every((c) => c.tagName === firstTag)) continue;

        const labels = children.map((c) => cleanText(c.textContent));
        const validLabels = labels.filter((t) => t.length > 0 && t.length <= 24);
        if (validLabels.length !== children.length) continue;
        if (validLabels.some((t) => oppositePattern.test(t) && !keywordPattern.test(t))) {
          continue;
        }
        const matches = validLabels.filter((t) => keywordPattern.test(t));
        if (matches.length >= Math.max(2, Math.ceil(children.length * 0.6))) {
          const seen = new Set<string>();
          const items: { el: HTMLElement; option: StreamOptionItem }[] = [];
          children.forEach((el, idx) => {
            const label = cleanText(el.textContent);
            if (!label || seen.has(label)) return;
            seen.add(label);
            items.push({
              el,
              option: {
                id: `${idx}:${label}`,
                label,
                active: isElementActive(el, triggerText),
                locked: isOptionLocked(el),
              },
            });
          });
          if (items.length >= 2) return { items, source: 'dom' };
        }
      }
    }
  }
  return null;
}

/**
 * Query Bilibili's native main-world EmbedPlayer.instance (works top-frame & blanc iframe).
 */
async function readBilibiliMainWorldQualities(): Promise<DiscoveredGroup | null> {
  try {
    const data = (await webFrame.executeJavaScript(`(() => {
      const findInst = () => {
        if (window.EmbedPlayer?.instance?.getPlayerInfo) return window.EmbedPlayer.instance;
        const iframes = document.querySelectorAll('iframe');
        for (const f of iframes) {
          try {
            if (f.contentWindow?.EmbedPlayer?.instance?.getPlayerInfo) {
              return f.contentWindow.EmbedPlayer.instance;
            }
          } catch {}
        }
        return null;
      };
      const inst = findInst();
      if (!inst) return null;
      const info = inst.getPlayerInfo();
      if (!info || !Array.isArray(info.qualityCandidates)) return null;
      return {
        current: String(info.quality ?? ''),
        candidates: info.qualityCandidates.map(c => ({ qn: String(c.qn), desc: String(c.desc) }))
      };
    })()`)) as {
      current: string;
      candidates: { qn: string; desc: string }[];
    } | null;

    if (!data || data.candidates.length === 0) return null;
    return {
      source: 'bili-api',
      items: data.candidates.map((c) => ({
        el: null,
        option: {
          id: `bili:${c.qn}`,
          label: c.desc,
          active: c.qn === data.current,
          locked: false,
        },
      })),
    };
  } catch {
    return null;
  }
}

async function discoverGroups(): Promise<{
  qualityGroup: DiscoveredGroup | null;
  lineGroup: DiscoveredGroup | null;
}> {
  const platform = detectPlatform();
  const scopes = getSearchScopes();
  const qualityTriggerText = cleanText(findQualityTrigger(scopes)?.textContent);
  const lineTriggerText = cleanText(findLineTrigger(scopes)?.textContent);

  const qualitySelectorsByPlatform: Record<PlatformId, string[]> = {
    huya: ['.player-videotype-list li', '#player-videotype-list li'],
    douyu: ['[class*="rate"] ul li', '[class*="menu-"] li'],
    bilibili: ['.quality-wrap .list-it', '.quality-panel .item', '.quality-list li'],
    douyin: ['.xgplayer-definition ul li', '[data-e2e="quality-list"] li'],
  };

  const lineSelectorsByPlatform: Record<PlatformId, string[]> = {
    huya: ['.player-videoline-list li', '.player-line-list li', '#player-line-list li'],
    douyu: ['[class*="line"] ul li', '[class*="cdn"] li'],
    bilibili: ['.line-wrap .list-it', '[class*="line-list"] li'],
    douyin: ['.xgplayer-line ul li', '[class*="line-list"] li'],
  };

  let qualityGroup: DiscoveredGroup | null = null;
  if (platform === 'bilibili') {
    qualityGroup = await readBilibiliMainWorldQualities();
  }
  if (!qualityGroup && platform) {
    qualityGroup = extractGroupBySelectors(
      scopes,
      qualitySelectorsByPlatform[platform],
      qualityTriggerText
    );
  }
  if (!qualityGroup) {
    qualityGroup = extractGroupHeuristically(scopes, QUALITY_KW, LINE_KW, qualityTriggerText);
  }

  let lineGroup = platform
    ? extractGroupBySelectors(scopes, lineSelectorsByPlatform[platform], lineTriggerText)
    : null;
  if (!lineGroup) {
    lineGroup = extractGroupHeuristically(scopes, LINE_KW, QUALITY_KW, lineTriggerText);
  }

  return { qualityGroup, lineGroup };
}

async function emitStreamOptions(force = false): Promise<void> {
  try {
    const { qualityGroup, lineGroup } = await discoverGroups();
    const payload: StreamOptionsInfo = {
      qualities: qualityGroup ? qualityGroup.items.map((i) => i.option) : [],
      lines: lineGroup ? lineGroup.items.map((i) => i.option) : [],
    };
    const serialized = JSON.stringify(payload);
    if (!force && serialized === lastEmittedJson) return;
    lastEmittedJson = serialized;
    ipcRenderer.sendToHost('livehub:stream-options', payload);
  } catch {
    // Ignore transient DOM states
  }
}

async function probeStreamOptions(allowClickFallback: boolean): Promise<void> {
  const scopes = getSearchScopes();
  const qTrigger = findQualityTrigger(scopes);
  const lTrigger = findLineTrigger(scopes);

  if (qTrigger) {
    simulateHover(qTrigger, true);
    await sleep(180);
    await emitStreamOptions(true);
    simulateHover(qTrigger, false);
  }

  if (lTrigger) {
    simulateHover(lTrigger, true);
    await sleep(180);
    await emitStreamOptions(true);
    simulateHover(lTrigger, false);
  }

  if (allowClickFallback) {
    const { qualityGroup, lineGroup } = await discoverGroups();
    if (!qualityGroup && qTrigger) {
      simulateClick(qTrigger);
      await sleep(220);
      await emitStreamOptions(true);
      simulateClick(qTrigger);
    }
    if (!lineGroup && lTrigger) {
      simulateClick(lTrigger);
      await sleep(220);
      await emitStreamOptions(true);
      simulateClick(lTrigger);
    }
  }

  await emitStreamOptions(true);
}

async function selectStreamOption(kind: 'quality' | 'line', targetId: string): Promise<void> {
  const platform = detectPlatform();

  // Bilibili native main-world API switch
  if (kind === 'quality' && platform === 'bilibili' && targetId.startsWith('bili:')) {
    const qn = targetId.slice('bili:'.length);
    try {
      await webFrame.executeJavaScript(`(async () => {
        const findInst = () => {
          if (window.EmbedPlayer?.instance) return window.EmbedPlayer.instance;
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            try {
              if (f.contentWindow?.EmbedPlayer?.instance) return f.contentWindow.EmbedPlayer.instance;
            } catch {}
          }
          return null;
        };
        const inst = findInst();
        if (!inst) return;
        if (typeof inst.switchQualityAsync === 'function') {
          await inst.switchQualityAsync(${JSON.stringify(qn)});
        } else if (typeof inst.switchQuality === 'function') {
          inst.switchQuality(${JSON.stringify(qn)});
        }
      })()`);
    } catch {
      // Fallback to DOM below if API threw
    }
    await sleep(600);
    await emitStreamOptions(true);
    return;
  }

  const scopes = getSearchScopes();
  const trigger = kind === 'quality' ? findQualityTrigger(scopes) : findLineTrigger(scopes);
  let group =
    kind === 'quality'
      ? (await discoverGroups()).qualityGroup
      : (await discoverGroups()).lineGroup;

  if (!group && trigger) {
    simulateHover(trigger, true);
    await sleep(180);
    group =
      kind === 'quality'
        ? (await discoverGroups()).qualityGroup
        : (await discoverGroups()).lineGroup;
    if (!group) {
      simulateClick(trigger);
      await sleep(200);
      group =
        kind === 'quality'
          ? (await discoverGroups()).qualityGroup
          : (await discoverGroups()).lineGroup;
    }
  }

  if (group) {
    const targetLabel = targetId.includes(':') ? targetId.split(':').slice(1).join(':') : targetId;
    const match =
      group.items.find((i) => i.option.id === targetId) ||
      group.items.find((i) => i.option.label === targetLabel);

    if (match?.el) {
      if (trigger) {
        simulateHover(trigger, true);
        await sleep(60);
      }
      simulateClick(match.el);
      if (trigger) {
        window.setTimeout(() => simulateHover(trigger, false), 150);
      }
    }
  }

  await sleep(600);
  await emitStreamOptions(true);
}

function ensureStyleTagInDoc(doc: Document): void {
  if (doc.getElementById('livehub-purify-style')) return;
  const target = doc.head || doc.documentElement;
  if (!target) return;

  const styleEl = doc.createElement('style');
  styleEl.id = 'livehub-purify-style';
  styleEl.textContent = PURIFY_CSS;
  target.appendChild(styleEl);
}

function tagPlayerRootInDoc(doc: Document, platform: PlatformId): void {
  let candidate: Element | null = null;

  if (platform === 'huya') {
    // Must wrap #videoContainer so #player-ctrl-wrap (controls/quality/line) stays visible!
    candidate = doc.querySelector('#videoContainer') || doc.querySelector('#player-wrap');
  } else if (platform === 'douyu') {
    candidate =
      doc.querySelector('#js-player-video-case') ||
      doc.querySelector('.layout-Player-video') ||
      doc.querySelector('#room-html5-player');
  } else if (platform === 'bilibili') {
    candidate =
      doc.querySelector('#live-player-ctnr') ||
      doc.querySelector('#player-ctnr') ||
      doc.querySelector('.live-player-mounter');
    if (!candidate && doc === document) {
      // Official/event rooms like live.bilibili.com/6 mount the room inside an iframe
      candidate = doc.querySelector(
        'iframe[src*="live.bilibili.com/blanc"], iframe[src*="live.bilibili.com/"]'
      );
    }
  } else if (platform === 'douyin') {
    const players = Array.from(
      doc.querySelectorAll<HTMLElement>(
        '[data-e2e="living-container"] .douyin-player, [data-e2e="living-container"] .xgplayer, .douyin-player, .xgplayer'
      )
    ).filter((el) => !el.closest('.__pre_create_player__') && !el.className.includes('PreCreatePlayer'));

    // Pick the active player containing a real video with largest area
    let bestArea = -1;
    for (const p of players) {
      const hasVid = Boolean(p.querySelector('video'));
      if (!hasVid) continue;
      const r = p.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        candidate = p;
      }
    }
    if (!candidate) {
      candidate = players[0] || doc.querySelector('[data-e2e="living-container"]') || null;
    }
  }

  if (candidate && candidate.getAttribute('data-livehub-player-root') !== '1') {
    doc
      .querySelectorAll('[data-livehub-player-root="1"]')
      .forEach((el) => el.removeAttribute('data-livehub-player-root'));
    candidate.setAttribute('data-livehub-player-root', '1');
    (doc.defaultView || window).dispatchEvent(new Event('resize'));
  }
}

function pauseStrayBackgroundVideos(doc: Document): void {
  if (currentConfig.mode !== 'pure') return;
  const root = doc.querySelector('[data-livehub-player-root="1"]');
  if (!root) return;
  const videos = Array.from(doc.querySelectorAll<HTMLVideoElement>('video'));
  for (const v of videos) {
    if (!root.contains(v) && !v.paused) {
      try {
        v.muted = true;
        v.pause();
      } catch {
        // Ignore
      }
    }
  }
}

function runAdSkipper(): void {
  const platform = detectPlatform();
  if (!platform) return;

  for (const doc of getPlayerDocuments()) {
    try {
      if (platform === 'huya') {
        // Based on weihubeats/Huya-Ad-Skipper
        const skipOrClose = Array.from(
          doc.querySelectorAll<HTMLElement>(
            '.ab-skip, .player-ad-skip, .ab-close, .ab-close-2, .player-ad-close, .room-ad-close, .ext-room-ad-close, .gg-close, [id*="ad_close"]'
          )
        );
        for (const el of skipOrClose) {
          if (el.offsetParent !== null) {
            el.click();
          }
        }
        const abTags = Array.from(doc.querySelectorAll<HTMLElement>('.new-ad-close-style i'));
        for (const tag of abTags) {
          if (tag.offsetParent !== null && (tag.textContent || '').includes('关闭')) {
            tag.click();
          }
        }
      } else if (platform === 'douyu') {
        const adCloses = Array.from(
          doc.querySelectorAll<HTMLElement>(
            '.LotteryContainer [class*="close"], .PaladinWeek-toast [class*="close"], .ChargeGuide [class*="close"], .SignInBox [class*="close"]'
          )
        );
        for (const el of adCloses) {
          if (el.offsetParent !== null) {
            el.click();
          }
        }
      } else if (platform === 'bilibili') {
        const popCloses = Array.from(
          doc.querySelectorAll<HTMLElement>(
            '.web-live-room-qa-pop .close, .ads-panel .close, .vip-guide-tip .close-btn'
          )
        );
        for (const el of popCloses) {
          if (el.offsetParent !== null) {
            el.click();
          }
        }
      } else if (platform === 'douyin') {
        // Based on YU-1021/better-douyin: dismiss/remove forced login & feature-guide overlays in pure mode
        if (currentConfig.mode === 'pure') {
          doc
            .querySelectorAll(
              '.douyin_login_iframe, div[id^="login-full-panel-"], [id^="related-video-card-login-guide"]'
            )
            .forEach((el) => el.remove());

          // Dismiss Douyin floating feature-promo dialogs (e.g. "新功能：三屏模式")
          const tripleCanvases = Array.from(
            doc.querySelectorAll<HTMLElement>('canvas.douyin-player-triple-video-canvas')
          );
          for (const cv of tripleCanvases) {
            let box: HTMLElement | null = cv.parentElement;
            for (let depth = 0; depth < 6 && box; depth++) {
              const txt = box.innerText || '';
              if (txt.includes('三屏模式') || txt.includes('点击体验')) {
                const closeBtn = box.querySelector<HTMLElement>('svg, button, [class*="close"]');
                if (closeBtn) {
                  try {
                    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  } catch {
                    // Ignore
                  }
                }
                box.style.setProperty('display', 'none', 'important');
                break;
              }
              box = box.parentElement;
            }
          }
        }
      }
    } catch {
      // Ignore transient DOM exceptions
    }
  }
}

function applyConfigAttributes(forceResize = false): void {
  const platform = detectPlatform();
  for (const doc of getPlayerDocuments()) {
    const root = doc.documentElement;
    if (!root) continue;

    if (platform && root.getAttribute('data-livehub-platform') !== platform) {
      root.setAttribute('data-livehub-platform', platform);
    }
    if (root.getAttribute('data-livehub-adblock') !== '1') {
      root.setAttribute('data-livehub-adblock', '1');
    }
    const pureVal = currentConfig.mode === 'pure' ? '1' : '0';
    const modeChanged = root.getAttribute('data-livehub-pure') !== pureVal;
    if (modeChanged) root.setAttribute('data-livehub-pure', pureVal);

    const giftsVal = currentConfig.hideGiftEffects ? '1' : '0';
    if (root.getAttribute('data-livehub-hide-gifts') !== giftsVal) {
      root.setAttribute('data-livehub-hide-gifts', giftsVal);
    }

    const danmakuVal = currentConfig.danmakuEnabled ? '1' : '0';
    if (root.getAttribute('data-livehub-danmaku') !== danmakuVal) {
      root.setAttribute('data-livehub-danmaku', danmakuVal);
    }

    ensureStyleTagInDoc(doc);
    if (platform) {
      tagPlayerRootInDoc(doc, platform);
    }
    pauseStrayBackgroundVideos(doc);

    if (forceResize || modeChanged) {
      (doc.defaultView || window).dispatchEvent(new Event('resize'));
    }
  }
}

async function tryAutoHighestQuality(): Promise<void> {
  if (!currentConfig.autoHighestQuality) return;
  const href = window.location.href;
  if (href === lastQualityUrl) return;

  const { qualityGroup } = await discoverGroups();
  if (!qualityGroup || qualityGroup.items.length === 0) return;

  const unlocked = qualityGroup.items.filter((i) => !i.option.locked);
  const preferred =
    unlocked.find((i) => /原画|4K|真彩/.test(i.option.label)) ||
    unlocked.find((i) => /蓝光/.test(i.option.label)) ||
    unlocked[0];

  if (preferred && !preferred.option.active) {
    await selectStreamOption('quality', preferred.option.id);
  }
  lastQualityUrl = href;
}

const INITIAL_DOUYIN_ROOM_PATH =
  window.location.hostname.toLowerCase().includes('live.douyin.com') &&
  /^\/\d+\/?$/.test(window.location.pathname)
    ? window.location.pathname.replace(/\/+$/, '')
    : null;

function installDouyinOfflinePlazaGuard(): void {
  if (!INITIAL_DOUYIN_ROOM_PATH) return;
  try {
    void webFrame.executeJavaScript(`(() => {
      if (window.__livehubDouyinGuard) return;
      window.__livehubDouyinGuard = true;
      const lockedPath = ${JSON.stringify(INITIAL_DOUYIN_ROOM_PATH)};
      const isPlazaTarget = (u) => {
        if (!u) return false;
        try {
          const parsed = new URL(String(u), window.location.origin);
          if (!parsed.hostname.includes('live.douyin.com')) return false;
          const p = parsed.pathname.replace(/\\/+$/, '') || '/';
          return p === '/' || p.startsWith('/category');
        } catch {
          return false;
        }
      };
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      history.pushState = function(state, title, url) {
        if (isPlazaTarget(url)) return;
        return origPush(state, title, url);
      };
      history.replaceState = function(state, title, url) {
        if (isPlazaTarget(url)) return;
        return origReplace(state, title, url);
      };
      // If Douyin already swapped URL to plaza before script ran, stop auto-playing plaza feed
      if (window.location.pathname.replace(/\\/+$/, '') !== lockedPath && isPlazaTarget(window.location.href)) {
        document.querySelectorAll('video').forEach((v) => { try { v.pause(); v.muted = true; } catch {} });
      }
    })()`);
  } catch {
    // Ignore
  }
}

function sendMetaToHost(): void {
  try {
    const rawTitle = (document.title || '')
      .replace(/[-_｜|]\s*(虎牙直播|斗鱼直播|哔哩哔哩直播|抖音直播).*$/i, '')
      .trim();
    const isGenericDouyinPlazaTitle =
      Boolean(INITIAL_DOUYIN_ROOM_PATH) &&
      (!rawTitle || /^(抖音直播广场|抖音直播|抖音-记录美好生活|直播广场)$/i.test(rawTitle));
    const hasVideo = getPlayerDocuments().some((doc) => Boolean(doc.querySelector('video')));
    ipcRenderer.sendToHost('livehub:meta', {
      title: isGenericDouyinPlazaTitle ? '' : rawTitle || document.title,
      url: window.location.href,
      hasVideo,
    });
  } catch {
    // Ignore if host listener is unavailable
  }
}

ipcRenderer.on('livehub:config', (_event, config: Partial<WebviewPurifyConfig>) => {
  currentConfig = { ...currentConfig, ...config };
  applyConfigAttributes();
});

ipcRenderer.on('livehub:probe-options', () => {
  void probeStreamOptions(true);
});

ipcRenderer.on('livehub:select-quality', (_event, targetId: string) => {
  void selectStreamOption('quality', targetId);
});

ipcRenderer.on('livehub:select-line', (_event, targetId: string) => {
  void selectStreamOption('line', targetId);
});

function needsPlayerRootRefresh(): boolean {
  return getPlayerDocuments().some((doc) => {
    const curRoot = doc.querySelector('[data-livehub-player-root="1"]');
    if (!curRoot || !doc.getElementById('livehub-purify-style')) return true;
    return (
      curRoot.getAttribute('data-e2e') === 'living-container' &&
      Boolean(doc.querySelector('.douyin-player video, .xgplayer video'))
    );
  });
}

function startEarlyPurify(): void {
  // Apply purify CSS at document_start so hidden sidebars/gifts/ads never lay out or paint during page load
  const attach = () => {
    if (!document.documentElement) {
      window.setTimeout(attach, 16);
      return;
    }
    installDouyinOfflinePlazaGuard();
    applyConfigAttributes(false);
    sendMetaToHost();

    let mutationTimer: number | null = null;
    const observer = new MutationObserver(() => {
      if (mutationTimer !== null) return;
      mutationTimer = window.setTimeout(() => {
        mutationTimer = null;
        if (needsPlayerRootRefresh()) {
          applyConfigAttributes(false);
        }
      }, 600);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  attach();
}

function bootstrap(): void {
  applyConfigAttributes(true);
  sendMetaToHost();

  window.setTimeout(() => {
    applyConfigAttributes(false);
    runAdSkipper();
    void probeStreamOptions(false).then(() => {
      void tryAutoHighestQuality();
    });
    sendMetaToHost();
  }, 1400);

  window.setTimeout(() => {
    runAdSkipper();
    void emitStreamOptions(false);
  }, 3000);

  let adTickCount = 0;
  const runAdSkipperLoop = () => {
    if (!document.hidden) {
      runAdSkipper();
    }
    adTickCount += 1;
    // Run briskly during the first ~20s after load for startup ad popups, then back off to 5s to save CPU
    window.setTimeout(runAdSkipperLoop, adTickCount < 12 ? 1500 : 5000);
  };
  window.setTimeout(runAdSkipperLoop, 1500);

  let steadyOptionTicks = 0;
  window.setInterval(() => {
    if (document.hidden) return;
    if (needsPlayerRootRefresh()) {
      applyConfigAttributes(false);
    }
    sendMetaToHost();
    if (window.location.href !== lastProbedUrl) {
      lastProbedUrl = window.location.href;
      steadyOptionTicks = 0;
      window.setTimeout(() => {
        applyConfigAttributes(true);
        void probeStreamOptions(false).then(() => {
          void tryAutoHighestQuality();
        });
      }, 1500);
    } else {
      // Once stream options are already discovered on this URL, only re-scan every ~30s instead of every 6s
      steadyOptionTicks += 1;
      const hasOptions = lastEmittedJson.length > 30;
      if (!hasOptions || steadyOptionTicks % 5 === 0) {
        void emitStreamOptions(false);
      }
    }
  }, 6000);
}

startEarlyPurify();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
