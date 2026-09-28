const IG_NS = 'ig-reels-pip';
const YT_NS = 'yt-shorts-pip';

const IG_DOWNLOAD_FOLDER = 'IG-Templates-60GB';
const IG_DOWNLOAD_TRACKING_PREFIX = 'igReelsPipTrackedDownload:';
const activeTrackedDownloads = new Map();

function safeInstagramDownloadFilename(value) {
  const raw = String(value || 'reel.mp4').split(/[\\/]/).pop() || 'reel.mp4';
  let base = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!base) base = 'reel.mp4';
  if (!base.toLowerCase().endsWith('.mp4')) base += '.mp4';
  return `${IG_DOWNLOAD_FOLDER}/${base}`;
}

function trackedDownloadKey(downloadId) {
  return `${IG_DOWNLOAD_TRACKING_PREFIX}${downloadId}`;
}

function readTrackedDownload(downloadId, callback) {
  const memoryItem = activeTrackedDownloads.get(String(downloadId));
  if (memoryItem) {
    callback(memoryItem);
    return;
  }

  const key = trackedDownloadKey(downloadId);
  chrome.storage.local.get({ [key]: null }, result => {
    const item = result?.[key];
    callback(item && typeof item === 'object' && !Array.isArray(item) ? item : null);
  });
}

function rememberDownload(downloadId, tabId, requestId, callback = () => {}) {
  const id = String(downloadId);
  const key = trackedDownloadKey(downloadId);
  const item = {
    tabId: Number.isInteger(tabId) ? tabId : null,
    requestId: typeof requestId === 'string' ? requestId : '',
  };
  activeTrackedDownloads.set(id, item);
  chrome.storage.local.set({ [key]: item }, () => {
    if (!activeTrackedDownloads.has(id)) {
      chrome.storage.local.remove(key, callback);
      return;
    }
    callback();
  });
}

function forgetDownload(downloadId, callback = () => {}) {
  activeTrackedDownloads.delete(String(downloadId));
  chrome.storage.local.remove(trackedDownloadKey(downloadId), callback);
}

function eraseTrackedDownload(downloadId) {
  chrome.downloads.erase({ id: downloadId }, () => {
    void chrome.runtime.lastError;
    forgetDownload(downloadId);
  });
}

chrome.downloads.onChanged.addListener(delta => {
  const state = delta?.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  readTrackedDownload(delta.id, item => {
    if (!item) return;

    const message = {
      namespace: IG_NS,
      type: 'download-finished',
      requestId: item.requestId,
      downloadId: delta.id,
      state,
      error: delta?.error?.current || null,
    };

    if (Number.isInteger(item.tabId)) {
      Promise.resolve(safeSend(item.tabId, message)).finally(() => {
        eraseTrackedDownload(delta.id);
      });
    } else {
      eraseTrackedDownload(delta.id);
    }
  });
});


function namespaceForTab(tab) {
  const url = String(tab?.url || '');
  if (url.startsWith('https://www.instagram.com/')) return IG_NS;
  if (url.startsWith('https://www.youtube.com/shorts/')) return YT_NS;
  return null;
}

async function safeSend(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function mediaTabs() {
  return await chrome.tabs.query({
    url: ['https://www.instagram.com/*', 'https://www.youtube.com/shorts/*'],
  });
}

async function findMediaTargets() {
  const tabs = await mediaTabs();
  const targets = [];
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    const namespace = namespaceForTab(tab);
    if (!namespace) continue;
    const status = await safeSend(tab.id, { namespace, type: 'status' });
    targets.push({ tab, namespace, status });
  }

  targets.sort((a, b) => {
    const aPip = a.status?.pipActive ? 1 : 0;
    const bPip = b.status?.pipActive ? 1 : 0;
    if (aPip !== bPip) return bPip - aPip;
    return Number(Boolean(b.tab.active)) - Number(Boolean(a.tab.active));
  });
  return targets;
}

async function routeSwitch(direction) {
  const tabs = await mediaTabs();
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    const namespace = namespaceForTab(tab);
    if (!namespace) continue;
    const result = await safeSend(tab.id, { namespace, type: 'switch', direction });
    if (result?.ok) {
      console.log(`[Media PiP] ${direction} handled by tab ${tab.id}; PiP=${Boolean(result.pipActive)}`);
      return;
    }
  }
  console.warn(`[Media PiP] ${direction} command was not handled by an active PiP tab.`);
}

async function routeAction(action) {
  const targets = await findMediaTargets();
  if (!targets.length) return;
  const target = targets.find(item => item.status?.pipActive)
    || targets.find(item => item.tab.active)
    || targets[0];
  if (typeof target?.tab?.id !== 'number') return;
  await safeSend(target.tab.id, { namespace: target.namespace, type: 'action', action });
}

async function emergencyCloseMediaTab() {
  const targets = await findMediaTargets();
  if (!targets.length) return;
  const target = targets.find(item => item.status?.pipActive)
    || targets.find(item => item.tab.active)
    || targets[0];
  if (typeof target?.tab?.id === 'number') await chrome.tabs.remove(target.tab.id);
}

function trustedInstagramMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      host.endsWith('.cdninstagram.com')
      || host.endsWith('.fbcdn.net')
      || host === 'instagram.com'
      || host.endsWith('.instagram.com')
    );
  } catch (_) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.namespace !== IG_NS) return undefined;

  if (message.type === 'download' && typeof message.url === 'string') {
    if (!trustedInstagramMediaUrl(message.url)) {
      sendResponse({ ok: false, error: 'untrusted-instagram-media-url' });
      return false;
    }

    chrome.downloads.download({
      url: message.url,
      filename: safeInstagramDownloadFilename(message.filename),
      saveAs: false,
      conflictAction: 'uniquify',
    }, downloadId => {
      const error = chrome.runtime.lastError;
      if (error) {
        sendResponse({ ok: false, error: error.message });
        return;
      }

      rememberDownload(downloadId, sender?.tab?.id, message.requestId, () => {
        sendResponse({ ok: true, downloadId });
      });
    });
    return true;
  }

  return undefined;
});

chrome.commands.onCommand.addListener(command => {
  if (command === 'previous-reel-global-v2') {
    routeSwitch('up');
  } else if (command === 'next-reel-global-v2') {
    routeSwitch('down');
  } else if (command === 'emergency-close-global-v1') {
    emergencyCloseMediaTab();
  } else if (command === 'like-reel-global-v1') {
    routeAction('like');
  }
});
