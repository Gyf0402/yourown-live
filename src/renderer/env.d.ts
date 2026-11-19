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
  setAudioMuted: (muted: boolean) => void;
  isAudioMuted: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  getWebContentsId: () => number;
  openDevTools: () => void;
}
