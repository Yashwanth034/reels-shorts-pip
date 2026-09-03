(() => {
  'use strict';

  let sequence = 0;
  const pending = new Map();

  function requestMain(type, extra = {}, timeoutMs = 3500) {
    const requestId = `igpip-${Date.now()}-${++sequence}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: 'main-world-timeout' });
      }, timeoutMs);

      pending.set(requestId, { resolve, timer });
      window.postMessage({
        source: 'IG_REELS_PIP_BRIDGE_V1',
        requestId,
        type,
        ...extra,
      }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || !msg) return;

    if (msg.source === 'IG_REELS_PIP_DOWNLOAD_V1') {
      chrome.runtime.sendMessage({
        namespace: 'ig-reels-pip',
        type: 'download',
        url: msg.url,
        filename: msg.filename,
      }).then(response => {
        window.postMessage({
          source: 'IG_REELS_PIP_DOWNLOAD_RESULT_V1',
          requestId: msg.requestId,
          response: response || { ok: false, error: 'empty-download-response' },
        }, '*');
      }).catch(error => {
        window.postMessage({
          source: 'IG_REELS_PIP_DOWNLOAD_RESULT_V1',
          requestId: msg.requestId,
          response: { ok: false, error: String(error?.message || error) },
        }, '*');
      });
      return;
    }

    if (msg.source !== 'IG_REELS_PIP_MAIN_V1') return;

    const item = pending.get(msg.requestId);
    if (!item) return;

    clearTimeout(item.timer);
    pending.delete(msg.requestId);
    item.resolve(msg.response || { ok: false, error: 'empty-main-response' });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.namespace !== 'ig-reels-pip') return undefined;

    if (message.type === 'status') {
      requestMain('status').then(sendResponse);
      return true;
    }

    if (message.type === 'switch' && (message.direction === 'up' || message.direction === 'down')) {
      // Instagram's virtualized feed can take several seconds to expose the next reel,
      // especially while the tab is minimized/backgrounded. Keep the bridge alive long
      // enough for the MAIN-world 12s switch resolver to finish.
      requestMain('switch', { direction: message.direction }, 15000).then(sendResponse);
      return true;
    }

    if (message.type === 'action' && message.action === 'like') {
      requestMain('action', { action: message.action }, 5000).then(sendResponse);
      return true;
    }

    sendResponse({ ok: false, error: 'unsupported-extension-message' });
    return false;
  });
})();
