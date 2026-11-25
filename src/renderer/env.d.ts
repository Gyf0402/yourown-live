/// <reference types="vite/client" />
import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import type { LiveHubAPI } from '../shared/types';

declare global {
  interface Window {
    livehub: LiveHubAPI;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          preload?: string;
          useragent?: string;
          allowpopups?: string | boolean;
        },
        HTMLElement
      >;
    }
  }
}

export interface WebviewElement extends HTMLElement {
  src: string;
  reload: () => void;
  stop: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  setZoomFactor: (factor: number) => void;
  getZoomFactor: () => number;
  insertCSS: (css: string) => Promise<string>;
  setAudioMuted: (muted: boolean) => void;
  isAudioMuted: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  getWebContentsId: () => number;
  openDevTools: () => void;
}
