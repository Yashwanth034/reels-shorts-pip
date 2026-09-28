(() => {
  'use strict';

  let sequence = 0;
  const pending = new Map();
  const NS = 'tiktok-pip';

  function requestMain(type, extra = {}, timeoutMs = 5000) {
    const requestId = `ttpip-${Date.now()}-${++sequence}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: 'main-world-timeout' });
      }, timeoutMs);

      pending.set(requestId, { resolve, timer });
      window.postMessage({ source: 'TIKTOK_PIP_BRIDGE_V1', requestId, type, ...extra }, '*');
    });
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.source !== 'TIKTOK_PIP_MAIN_V1') return;

    const item = pending.get(msg.requestId);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(msg.requestId);
    item.resolve(msg.response || { ok: false, error: 'empty-main-response' });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.namespace !== NS) return undefined;

    if (message.type === 'status') {
      requestMain('status').then(sendResponse);
      return true;
    }

    if (message.type === 'switch' && (message.direction === 'up' || message.direction === 'down')) {
      requestMain('switch', { direction: message.direction }, 12000).then(sendResponse);
      return true;
    }

    if (message.type === 'action' && message.action === 'like') {
      requestMain('action', { action: 'like' }).then(sendResponse);
      return true;
    }

    sendResponse({ ok: false, error: 'unsupported-extension-message' });
    return false;
  });
})();
