const IG_NS = 'ig-reels-pip';
const YT_NS = 'yt-shorts-pip';

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.namespace !== IG_NS) return undefined;

  if (message.type === 'download' && typeof message.url === 'string') {
    if (!trustedInstagramMediaUrl(message.url)) {
      sendResponse({ ok: false, error: 'untrusted-instagram-media-url' });
      return false;
    }

    chrome.downloads.download({
      url: message.url,
      filename: 'reel.mp4',
      saveAs: false,
      conflictAction: 'uniquify',
    }, downloadId => {
      const error = chrome.runtime.lastError;
      if (error) sendResponse({ ok: false, error: error.message });
      else sendResponse({ ok: true, downloadId });
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
