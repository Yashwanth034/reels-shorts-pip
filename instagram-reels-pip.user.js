// ==UserScript==
// @name         Instagram Reels PiP (Reliable Background Controls)
// @namespace    http://tampermonkey.net/
// @version      4.2.0
// @description  Reliable manual PiP for Instagram Reels. Arrow keys work while Instagram has keyboard focus; PiP/OS Previous/Next media controls work while the tab is backgrounded or Chrome is minimized.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[IG PiP]';
    const log = (...args) => console.log(TAG, ...args);
    const warn = (...args) => console.warn(TAG, ...args);

    // Instagram can pause a reel during the brief handoff where it becomes the new
    // PiP element. Protect only the active transition target for a short window so
    // the new PiP starts playing, while normal user pause behavior still works later.
    const nativePause = HTMLMediaElement.prototype.pause;

    const state = {
        userEnabled: false,
        switching: false,
        pendingDirection: null,
        pendingSource: null,
        lastVideo: null,
        switchToken: 0,
        button: null,
        observer: null,
        mediaRefreshTimer: null,
        protectedVideo: null,
        protectedUntil: 0,
        actionBar: null,
        lastAutoNextFingerprint: '',
        lastAutoNextAt: 0,
        mediaByCode: new Map(),
    };

    function installInstagramMediaCapture() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch !== 'function' || nativeFetch.__igPipWrapped) return;

        const wrappedFetch = async function (...args) {
            const response = await nativeFetch.apply(this, args);
            try {
                const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                if (/\/(?:graphql\/query|api\/v1\/)/i.test(requestUrl)) {
                    response.clone().json().then(indexInstagramMediaPayload).catch(() => {});
                }
            } catch (_) {}
            return response;
        };

        try { Object.defineProperty(wrappedFetch, '__igPipWrapped', { value: true }); } catch (_) {}
        window.fetch = wrappedFetch;
    }

    installInstagramMediaCapture();

    function isTransitionProtected(video) {
        return Boolean(video && state.protectedVideo === video && performance.now() < state.protectedUntil);
    }

    function protectTransitionVideo(video, durationMs = 3500) {
        if (!video) return;
        state.protectedVideo = video;
        state.protectedUntil = performance.now() + durationMs;
    }

    // Instagram frequently calls video.pause() when a reel becomes off-screen or its
    // bookkeeping says the tab/reel is inactive. While that exact video owns native PiP,
    // ignore only those page-script pause() calls. Chrome's PiP Pause/Play controls operate
    // at the browser/media layer and remain native; we do not auto-resume pause events.
    HTMLMediaElement.prototype.pause = function (...args) {
        const isActivePiPVideo = this instanceof HTMLVideoElement
            && state.userEnabled
            && document.pictureInPictureElement === this;

        if (isActivePiPVideo) {
            log('Blocked Instagram scripted pause() on active PiP reel');
            return;
        }

        return nativePause.apply(this, args);
    };

    // Installed at document-start before Instagram's React app. While our PiP is active,
    // keep Instagram from treating a minimized/background tab as a reason to pause the reel.
    // We do not prevent Chrome's native PiP Play/Pause controls from pausing the video.
    document.addEventListener('visibilitychange', event => {
        if (!state.userEnabled || !(document.pictureInPictureElement instanceof HTMLVideoElement)) return;
        refreshMediaControls();
        event.stopImmediatePropagation();
        log(`Shielded Instagram visibilitychange (${document.visibilityState}) while PiP is active`);
    }, true);

    function enforceSinglePlayingReel(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        const pipVideo = document.pictureInPictureElement;
        if (!state.userEnabled || !(pipVideo instanceof HTMLVideoElement)) return;
        if (video === pipVideo || isTransitionProtected(video)) return;

        // While PiP is active, Instagram may autoplay the newly visible reel after the
        // user scrolls. Stop that second player immediately so PiP remains the only audio
        // and playback owner.
        try { nativePause.call(video); } catch (_) {}
    }

    document.addEventListener('play', enforceSinglePlayingReel, true);

    function allVideos() {
        return Array.from(document.querySelectorAll('video')).filter(v => v.isConnected);
    }

    function pauseOtherReels(keep) {
        for (const video of allVideos()) {
            if (video !== keep && !video.paused) {
                try { nativePause.call(video); } catch (_) {}
            }
        }
    }

    function rectArea(rect) {
        return Math.max(0, rect.width) * Math.max(0, rect.height);
    }

    function visibleRatio(video) {
        const rect = video.getBoundingClientRect();
        const total = rectArea(rect);
        if (!total) return 0;

        const left = Math.max(0, rect.left);
        const right = Math.min(window.innerWidth, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        const visible = Math.max(0, right - left) * Math.max(0, bottom - top);
        return visible / total;
    }

    function viewportCenterDistance(video) {
        const r = video.getBoundingClientRect();
        const centerY = r.top + r.height / 2;
        return Math.abs(centerY - window.innerHeight / 2);
    }

    function getMostVisibleVideo(exclude = null) {
        const videos = allVideos().filter(v => v !== exclude);
        if (!videos.length) return null;

        videos.sort((a, b) => {
            const ratioDiff = visibleRatio(b) - visibleRatio(a);
            if (Math.abs(ratioDiff) > 0.02) return ratioDiff;
            return viewportCenterDistance(a) - viewportCenterDistance(b);
        });

        return videos[0] || null;
    }

    function isUsableVideo(video) {
        if (!video || !video.isConnected) return false;
        const r = video.getBoundingClientRect();
        return r.width >= 80 && r.height >= 80;
    }

    function reelFingerprint(video) {
        if (!(video instanceof HTMLVideoElement)) return '';

        const reelLink = video.closest('article, div')?.querySelector?.('a[href*="/reel/"], a[href*="/reels/"]');
        const href = reelLink?.href || '';
        const src = video.currentSrc || video.src || '';
        const poster = video.poster || '';
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
        return `${href}|${src}|${poster}|${duration}`;
    }

    function isDifferentReel(video, previous, previousFingerprint) {
        if (!video || !isUsableVideo(video)) return false;
        if (video !== previous) return true;
        const fingerprint = reelFingerprint(video);
        return Boolean(fingerprint && fingerprint !== previousFingerprint);
    }

    // Find the nearest reel in the requested vertical direction. Reel identity is based
    // on media/permalink data as well as DOM identity because Instagram can recycle the
    // same <video> node for many successive reels during long virtualized scrolling.
    function findDirectionalVideo(current, direction, currentFingerprint = reelFingerprint(current)) {
        const videos = allVideos().filter(v => isDifferentReel(v, current, currentFingerprint));
        if (!videos.length) return null;

        const currentRect = current?.getBoundingClientRect();
        const currentY = currentRect ? currentRect.top + currentRect.height / 2 : window.innerHeight / 2;
        const sign = direction === 'down' ? 1 : -1;

        const candidates = videos
            .map(video => {
                const r = video.getBoundingClientRect();
                const y = r.top + r.height / 2;
                const delta = (y - currentY) * sign;
                return { video, delta, ratio: visibleRatio(video) };
            })
            .filter(x => x.delta > 16 || visibleRatio(x.video) >= 0.55)
            .sort((a, b) => a.delta - b.delta || b.ratio - a.ratio);

        return candidates[0]?.video || null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function findScrollContainer(video) {
        let node = video?.parentElement || null;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            const overflowY = style.overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 40) {
                return node;
            }
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function instagramNavigationButton(direction, currentVideo) {
        const labels = direction === 'down'
            ? ['Next', 'Next reel', 'Next Reel']
            : ['Previous', 'Previous reel', 'Previous Reel'];
        const candidates = [];

        for (const label of labels) {
            const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(label) : label;
            for (const node of document.querySelectorAll(
                `button[aria-label="${escaped}"], [role="button"][aria-label="${escaped}"], svg[aria-label="${escaped}"]`
            )) {
                const clickable = node.closest?.('button,[role="button"]') || node;
                if (clickable instanceof HTMLElement && !candidates.includes(clickable)) candidates.push(clickable);
            }
        }

        const videoRect = currentVideo?.getBoundingClientRect?.();
        const usable = candidates.filter(button => {
            if (!button.isConnected || button.id?.startsWith('ig-reels-pip')) return false;
            const rect = button.getBoundingClientRect();
            if (rect.width < 12 || rect.height < 12) return false;
            if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
            // Instagram's reel-navigation arrows sit beside the reel. Avoid accidentally
            // clicking a carousel control that is overlaid inside the reel itself.
            if (videoRect && rect.left < videoRect.right - 8 && rect.right > videoRect.left + 8) return false;
            return true;
        });

        usable.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            const ay = ar.top + ar.height / 2;
            const by = br.top + br.height / 2;
            return direction === 'down' ? by - ay : ay - by;
        });
        return usable[0] || null;
    }

    function nudgeFeed(direction, currentVideo, fraction = 0.92) {
        // Prefer Instagram's own Reel navigation control. It drives Instagram's virtualized
        // feed state correctly and keeps loading more reels, whereas raw scrollBy can stop
        // working once Instagram recycles the surrounding DOM after many reels.
        const nativeButton = instagramNavigationButton(direction, currentVideo);
        if (nativeButton) {
            nativeButton.click();
            return;
        }

        const scroller = findScrollContainer(currentVideo);
        const viewport = scroller === document.scrollingElement || scroller === document.documentElement
            ? window.innerHeight
            : scroller.clientHeight;
        const amount = Math.max(320, Math.floor(viewport * fraction));
        const top = direction === 'down' ? amount : -amount;

        if (scroller === document.scrollingElement || scroller === document.documentElement) {
            window.scrollBy({ top, behavior: document.hidden ? 'auto' : 'smooth' });
        } else {
            scroller.scrollBy({ top, behavior: document.hidden ? 'auto' : 'smooth' });
        }
    }

    async function resolveReelAfterFeedMove(previousVideo, direction, timeoutMs = 12000) {
        const previousFingerprint = reelFingerprint(previousVideo);
        const started = performance.now();
        let nextNudgeAt = 0;
        let best = null;

        while (performance.now() - started < timeoutMs) {
            const visible = getMostVisibleVideo();
            if (visible) {
                const fingerprint = reelFingerprint(visible);
                if (fingerprint && fingerprint !== previousFingerprint && visibleRatio(visible) >= 0.30) {
                    return visible;
                }
                if (visible !== previousVideo && visibleRatio(visible) >= 0.30) best = visible;
            }

            const elapsed = performance.now() - started;
            if (elapsed >= nextNudgeAt) {
                // Anchor scrolling from the reel that is currently present on the page,
                // not from the old PiP node. Instagram may detach the PiP source after a
                // few virtualized reels even though the floating PiP window still exists.
                const scrollAnchor = getMostVisibleVideo() || previousVideo;
                nudgeFeed(direction, scrollAnchor, 0.92);
                nextNudgeAt = elapsed + (document.hidden ? 850 : 520);
            }

            await sleep(document.hidden ? 150 : 90);
        }

        if (best && reelFingerprint(best) !== previousFingerprint) return best;
        return null;
    }

    async function ensurePlayable(video) {
        if (!video) return false;
        try {
            if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                await Promise.race([
                    new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })),
                    sleep(1200),
                ]);
            }
            // Keep Instagram's own mute state. play() is best-effort because a reel may
            // already be playing and some states can reject harmlessly.
            await video.play().catch(() => {});
        } catch (_) {}
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    async function enterPiP(video, reason = 'manual') {
        if (!video || !document.pictureInPictureEnabled || video.disablePictureInPicture) {
            warn('PiP unavailable for target video');
            return false;
        }

        protectTransitionVideo(video);
        pauseOtherReels(video);
        await ensurePlayable(video);
        await primeMediaSessionForPiP(video);

        try {
            if (document.pictureInPictureElement !== video) {
                await video.requestPictureInPicture();
            }
            state.lastVideo = video;
            pauseOtherReels(video);
            await video.play().catch(() => {});
            refreshMediaControls();
            log(`PiP active (${reason})`);
            return true;
        } catch (err) {
            warn(`requestPictureInPicture failed (${reason})`, err?.name || err);
            return false;
        }
    }

    function scrollFallback(direction, viewportFraction = 0.82) {
        const amount = Math.max(280, Math.floor(window.innerHeight * viewportFraction));
        window.scrollBy({
            top: direction === 'down' ? amount : -amount,
            // Background/minimized tabs heavily throttle smooth-scroll/timer progress.
            behavior: document.visibilityState === 'hidden' ? 'auto' : 'smooth',
        });
    }

    async function switchReel(direction, source = 'keyboard') {
        if (state.switching) {
            state.pendingDirection = direction;
            state.pendingSource = source;
            log(`Queued ${direction} via ${source} while PiP replacement is settling`);
            return true;
        }

        const token = ++state.switchToken;
        const pipVideo = document.pictureInPictureElement;
        // Prefer the real PiP source while it is still mounted. Once Instagram virtualizes
        // that node away, use the currently visible page reel instead of a stale lastVideo.
        const connectedPiP = document.pictureInPictureElement instanceof HTMLVideoElement && document.pictureInPictureElement.isConnected
            ? document.pictureInPictureElement
            : null;
        const current = connectedPiP || getMostVisibleVideo() || state.lastVideo;
        if (!current) {
            warn('No reel video found');
            return false;
        }

        state.switching = true;
        log(`Switch ${direction} via ${source}`);

        try {
            // Always advance Instagram's feed first, then bind PiP to whatever reel becomes
            // visible. Do not depend on old neighboring DOM nodes: Instagram aggressively
            // removes and recycles them during normal long-form Reels browsing.
            const currentFingerprint = reelFingerprint(current);
            const target = await resolveReelAfterFeedMove(current, direction);

            if (token !== state.switchToken) return false;
            if (!target || reelFingerprint(target) === currentFingerprint) {
                warn('Instagram feed did not expose a different reel after repeated feed moves');
                return false;
            }

            state.lastVideo = target;

            if (state.userEnabled || pipVideo) {
                const ok = await enterPiP(target, `switch:${source}`);
                if (!ok) {
                    // Keep the old PiP if Chrome rejected replacement; do not forcibly exit it.
                    warn('Reel changed, but Chrome did not allow PiP replacement');
                }
            }
            return true;
        } finally {
            setTimeout(() => {
                if (token !== state.switchToken) return;

                state.switching = false;
                const queuedDirection = state.pendingDirection;
                const queuedSource = state.pendingSource;
                state.pendingDirection = null;
                state.pendingSource = null;

                if (queuedDirection) {
                    switchReel(queuedDirection, `${queuedSource || 'input'}:queued`);
                }
            }, 180);
        }
    }

    function installMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;

        const bind = (action, handler) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
                log(`Media Session action registered: ${action}`);
            } catch (_) {}
        };

        // Only own reel navigation. Play/Pause stays fully native so Chrome's PiP
        // control never fights extension state.
        bind('nexttrack', () => switchReel('down', 'media-next'));
        bind('previoustrack', () => switchReel('up', 'media-previous'));
    }

    function refreshMediaControls() {
        installMediaSessionHandlers();
        for (const delay of [60, 180, 500]) {
            setTimeout(() => installMediaSessionHandlers(), delay);
        }
    }

    async function primeMediaSessionForPiP(video) {
        // Chrome can create the very first PiP window before it has propagated newly
        // registered Media Session actions to the browser UI. Prime the active media
        // session first, give Chrome one render turn to observe it, then bind again.
        // This does not own Play/Pause; it only makes Previous/Next available before
        // the PiP window is created instead of trying to add them afterward.
        installMediaSessionHandlers();

        if ('mediaSession' in navigator && video instanceof HTMLVideoElement) {
            try {
                navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';
            } catch (_) {}
        }

        await new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });

        installMediaSessionHandlers();
    }

    function scheduleMediaSessionRefresh(delayMs = 120) {
        clearTimeout(state.mediaRefreshTimer);
        state.mediaRefreshTimer = setTimeout(() => {
            state.mediaRefreshTimer = null;
            installMediaSessionHandlers();
        }, delayMs);
    }

    function currentReelVideo() {
        return document.pictureInPictureElement instanceof HTMLVideoElement
            ? document.pictureInPictureElement
            : (getMostVisibleVideo() || state.lastVideo);
    }

    function clickableForAria(root, ariaLabel) {
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(ariaLabel) : ariaLabel.replace(/"/g, '\\"');
        const node = root?.querySelector?.(`[aria-label="${escaped}"]`);
        return node?.closest?.('button,[role="button"],a') || node || null;
    }

    function reelInteractionRoot(video) {
        if (!(video instanceof HTMLVideoElement)) return document;

        let node = video.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
            if (node.querySelector?.('[aria-label="Like"], [aria-label="Unlike"]')) {
                return node;
            }
        }

        return video.closest('article') || document;
    }

    function likeCurrentReel() {
        const video = currentReelVideo();
        const root = reelInteractionRoot(video);

        const unlike = clickableForAria(root, 'Unlike') || clickableForAria(document, 'Unlike');
        if (unlike) {
            log('Current reel is already liked');
            return true;
        }

        const like = clickableForAria(root, 'Like') || clickableForAria(document, 'Like');
        if (!like) {
            warn('Like control was not found for the current reel');
            return false;
        }

        like.click();
        log('Liked current reel');
        return true;
    }

    function reelShortcode(video = currentReelVideo()) {
        const roots = [];
        if (video instanceof HTMLVideoElement) {
            let node = video.parentElement;
            for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) roots.push(node);
        }
        roots.push(document);

        for (const root of roots) {
            const link = root?.querySelector?.('a[href*="/reel/"], a[href*="/reels/"]');
            const path = link?.getAttribute?.('href') || link?.href || '';
            const match = path.match(/\/(?:reel|reels)\/([^/?#]+)/i);
            if (match?.[1]) return match[1];
        }

        return location.pathname.match(/\/(?:reel|reels)\/([^/?#]+)/i)?.[1] || '';
    }

    function indexInstagramMediaPayload(payload) {
        if (!payload || typeof payload !== 'object') return;
        const stack = [payload];
        const seen = new Set();
        let visited = 0;

        while (stack.length && visited < 12000) {
            const node = stack.pop();
            if (!node || typeof node !== 'object' || seen.has(node)) continue;
            seen.add(node);
            visited++;

            if (typeof node.code === 'string' && Array.isArray(node.video_versions) && node.video_versions.length) {
                const versions = node.video_versions
                    .filter(item => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url))
                    .map(item => ({
                        url: item.url,
                        width: Number(item.width || 0),
                        height: Number(item.height || 0),
                        type: Number(item.type || 0),
                    }));
                if (versions.length) state.mediaByCode.set(node.code, versions);
            }

            if (Array.isArray(node)) {
                for (const item of node) if (item && typeof item === 'object') stack.push(item);
            } else {
                for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
            }
        }
    }

    function extractBalancedJsonArray(text, keyIndex) {
        const colon = text.indexOf(':', keyIndex);
        const start = text.indexOf('[', colon + 1);
        if (colon < 0 || start < 0) return null;

        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) return text.slice(start, i + 1);
            }
        }
        return null;
    }

    function embeddedProgressiveVersions(code) {
        if (!code) return [];
        const cached = state.mediaByCode.get(code);
        if (cached?.length) return cached;

        for (const script of Array.from(document.scripts)) {
            const text = script.textContent || '';
            if (!text.includes(code) || !text.includes('video_versions')) continue;
            const codeIndex = text.indexOf(`"code":"${code}"`);
            if (codeIndex < 0) continue;
            const versionsIndex = text.indexOf('"video_versions"', codeIndex);
            if (versionsIndex < 0) continue;
            const json = extractBalancedJsonArray(text, versionsIndex);
            if (!json) continue;
            try {
                const versions = JSON.parse(json)
                    .filter(item => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url))
                    .map(item => ({ url: item.url, width: Number(item.width || 0), height: Number(item.height || 0), type: Number(item.type || 0) }));
                if (versions.length) {
                    state.mediaByCode.set(code, versions);
                    return versions;
                }
            } catch (_) {}
        }
        return [];
    }

    function progressiveMediaCandidates(video) {
        const code = reelShortcode(video);
        const versions = embeddedProgressiveVersions(code);
        const unique = new Map();
        for (const item of versions) {
            if (!unique.has(item.url)) unique.set(item.url, item);
        }
        return Array.from(unique.values())
            .sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.width - a.width)
            .map(item => item.url);
    }

    function shortcodeToMediaId(code) {
        if (typeof code !== 'string' || !code) return '';
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let value = 0n;
        for (const char of code) {
            const digit = alphabet.indexOf(char);
            if (digit < 0) return '';
            value = value * 64n + BigInt(digit);
        }
        return value.toString();
    }

    async function fetchProgressiveVersionsFromInstagram(code) {
        if (!code) return [];
        const mediaId = shortcodeToMediaId(code);
        if (!mediaId) return [];

        try {
            const response = await fetch(`/api/v1/media/${mediaId}/info/`, {
                method: 'GET',
                credentials: 'include',
                cache: 'no-store',
                headers: {
                    'X-IG-App-ID': '936619743392459',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-Instagram-AJAX': '1',
                },
            });
            if (!response.ok) {
                warn(`Instagram media info fallback failed: HTTP ${response.status}`);
                return [];
            }

            const payload = await response.json();
            indexInstagramMediaPayload(payload);
            return state.mediaByCode.get(code) || [];
        } catch (error) {
            warn('Instagram media info fallback failed', error?.message || error);
            return [];
        }
    }

    async function resolveProgressiveMediaCandidates(video) {
        const code = reelShortcode(video);
        let versions = embeddedProgressiveVersions(code);
        if (!versions.length) {
            versions = await fetchProgressiveVersionsFromInstagram(code);
        }

        const unique = new Map();
        for (const item of versions) {
            if (item?.url && !unique.has(item.url)) unique.set(item.url, item);
        }
        return Array.from(unique.values())
            .sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.width - a.width)
            .map(item => item.url);
    }

    function downloadFilename() {
        return 'reel.mp4';
    }

    function requestExtensionDownload(url, filename) {
        const requestId = `igpip-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                window.removeEventListener('message', onResult);
                resolve({ ok: false, error: 'download-timeout' });
            }, 30000);

            function onResult(event) {
                const msg = event.data;
                if (event.source !== window || !msg || msg.source !== 'IG_REELS_PIP_DOWNLOAD_RESULT_V1' || msg.requestId !== requestId) return;
                clearTimeout(timer);
                window.removeEventListener('message', onResult);
                resolve(msg.response || { ok: false, error: 'empty-download-response' });
            }

            window.addEventListener('message', onResult);
            window.postMessage({
                source: 'IG_REELS_PIP_DOWNLOAD_V1',
                requestId,
                url,
                filename,
            }, '*');
        });
    }

    async function downloadCurrentReel() {
        const video = currentReelVideo();
        if (!video) {
            warn('No current reel is available to download');
            return false;
        }

        const code = reelShortcode(video);
        const candidates = await resolveProgressiveMediaCandidates(video);
        if (!candidates.length) {
            warn(`No progressive MP4 URL found in Instagram Relay data for reel ${code || '(unknown)'}`);
            return false;
        }

        for (const url of candidates) {
            const result = await requestExtensionDownload(url, downloadFilename(video));
            if (result?.ok) {
                log(`Started progressive reel download for ${code}`);
                return true;
            }
            warn('Progressive candidate failed', result?.error || 'unknown');
        }

        warn('All Instagram progressive video candidates failed');
        return false;
    }

    function maybeAutoAdvance(video, source) {
        if (!(video instanceof HTMLVideoElement) || !state.userEnabled) return;
        if (document.pictureInPictureElement !== video) return;

        const fingerprint = reelFingerprint(video);
        const now = performance.now();
        if (fingerprint === state.lastAutoNextFingerprint && now - state.lastAutoNextAt < 4000) return;

        state.lastAutoNextFingerprint = fingerprint;
        state.lastAutoNextAt = now;
        log(`Reel finished; advancing automatically (${source})`);
        switchReel('down', `auto-${source}`);
    }

    function handleReelEnded(event) {
        maybeAutoAdvance(event.target, 'ended');
    }

    function handleReelProgress(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement) || video.paused) return;
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;
        if (video.currentTime < Math.max(0, video.duration - 0.20)) return;
        maybeAutoAdvance(video, 'near-end');
    }

    function keyboardHandler(event) {
        if (event.defaultPrevented) return;

        const target = event.target;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

        if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            switchReel(event.key === 'ArrowDown' ? 'down' : 'up', 'arrow');
            return;
        }

        if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'l') {
            event.preventDefault();
            event.stopImmediatePropagation();
            likeCurrentReel();
            return;
        }

    }

    function installKeyboardHandler() {
        // A single window capture listener is sufficient. Installing both window and
        // document listeners can result in duplicated navigation on some event paths.
        window.removeEventListener('keydown', keyboardHandler, true);
        window.addEventListener('keydown', keyboardHandler, { capture: true, passive: false });
    }

    function createButton() {
        if (document.getElementById('ig-reels-pip-button')) {
            return document.getElementById('ig-reels-pip-button');
        }

        const btn = document.createElement('button');
        btn.id = 'ig-reels-pip-button';
        btn.type = 'button';
        btn.textContent = '⏏ PiP 4.2.0';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '90px',
            right: '20px',
            zIndex: '2147483647',
            background: 'rgba(0,0,0,.86)',
            color: '#fff',
            border: '2px solid #fff',
            padding: '11px 17px',
            borderRadius: '999px',
            cursor: 'pointer',
            fontSize: '15px',
            fontWeight: '700',
            fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 4px 16px rgba(0,0,0,.45)',
            display: 'none',
            userSelect: 'none',
        });

        btn.addEventListener('click', async () => {
            const video = getMostVisibleVideo() || allVideos()[0];
            if (!video) {
                alert('No Instagram video found.');
                return;
            }

            state.userEnabled = true;
            state.lastVideo = video;
            const ok = await enterPiP(video, 'manual');
            if (!ok) state.userEnabled = false;
        });

        document.body.appendChild(btn);
        return btn;
    }

    function createActionBar() {
        if (document.getElementById('ig-reels-pip-actions')) {
            return document.getElementById('ig-reels-pip-actions');
        }

        const bar = document.createElement('div');
        bar.id = 'ig-reels-pip-actions';
        Object.assign(bar.style, {
            position: 'fixed',
            bottom: '90px',
            right: '150px',
            zIndex: '2147483647',
            display: 'none',
            alignItems: 'center',
            gap: '7px',
            padding: '6px',
            borderRadius: '999px',
            background: 'rgba(0,0,0,.86)',
            border: '1px solid rgba(255,255,255,.45)',
            boxShadow: '0 4px 16px rgba(0,0,0,.35)',
        });

        const addAction = (text, title, handler) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.title = title;
            button.setAttribute('aria-label', title);
            Object.assign(button.style, {
                width: '34px',
                height: '34px',
                padding: '0',
                border: '0',
                borderRadius: '50%',
                background: 'transparent',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '19px',
                lineHeight: '34px',
                fontFamily: 'system-ui, sans-serif',
            });
            button.addEventListener('click', handler);
            bar.appendChild(button);
        };

        addAction('↓', 'Download clean reel source', () => downloadCurrentReel());

        document.body.appendChild(bar);
        return bar;
    }

    function updateButton() {
        const visible = allVideos().length > 0;
        if (state.button) state.button.style.display = visible ? 'block' : 'none';
        if (state.actionBar) state.actionBar.style.display = visible ? 'flex' : 'none';
    }

    function init() {
        if (!document.body) return;
        log('Initializing v4.2.0');

        state.button = createButton();
        state.actionBar = createActionBar();
        installKeyboardHandler();
        installMediaSessionHandlers();
        document.addEventListener('ended', handleReelEnded, true);
        document.addEventListener('timeupdate', handleReelProgress, true);

        state.observer = new MutationObserver(() => {
            updateButton();
            // Instagram mutates the reel tree heavily. Debounce re-registration so we
            // recover from Instagram replacing handlers without doing it on every mutation batch.
            scheduleMediaSessionRefresh();
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
        updateButton();

        document.addEventListener('enterpictureinpicture', event => {
            if (event.target instanceof HTMLVideoElement) {
                state.lastVideo = event.target;
                if (isTransitionProtected(event.target)) {
                    event.target.play().catch(() => {});
                }
                refreshMediaControls();
                log('enterpictureinpicture');
            }
        }, true);

        document.addEventListener('leavepictureinpicture', event => {
            // Do not disable user intent when Chrome is replacing old PiP with a new reel.
            if (state.switching) {
                log('Ignored leavepictureinpicture during reel replacement');
                return;
            }

            // Delay because replacement can dispatch leave before the new PiP element is set.
            setTimeout(() => {
                if (!document.pictureInPictureElement && !state.switching) {
                    state.userEnabled = false;
                    log('PiP closed');
                }
            }, 180);
        }, true);

        // Re-register on SPA navigation / tab restoration without touching playback.
        document.addEventListener('visibilitychange', () => {
            refreshMediaControls();
        });
        window.addEventListener('pageshow', () => {
            installKeyboardHandler();
            installMediaSessionHandlers();
            updateButton();
        });

        // Chrome-extension bridge. This is inert in normal Tampermonkey use. The extension's
        // isolated content script can ask this MAIN-world code to switch the already-active
        // PiP video even while the Instagram tab itself is in the background.
        window.addEventListener('message', async event => {
            const msg = event.data;
            if (event.source !== window || !msg || msg.source !== 'IG_REELS_PIP_BRIDGE_V1') return;

            let response;
            try {
                if (msg.type === 'status') {
                    response = {
                        ok: true,
                        pipActive: Boolean(document.pictureInPictureElement),
                        userEnabled: state.userEnabled,
                        videoCount: allVideos().length,
                        visibility: document.visibilityState,
                    };
                } else if (msg.type === 'switch' && (msg.direction === 'up' || msg.direction === 'down')) {
                    // Background worker broadcasts directly to Instagram tabs to avoid a
                    // throttled status round-trip. Only the tab that currently owns PiP may
                    // consume the global switch, preventing another Instagram tab from moving.
                    if (!document.pictureInPictureElement) {
                        response = { ok: false, pipActive: false, error: 'not-pip-owner' };
                    } else {
                        const handled = await switchReel(msg.direction, 'extension-global');
                        response = {
                            ok: handled,
                            pipActive: Boolean(document.pictureInPictureElement),
                        };
                    }
                } else if (msg.type === 'action' && msg.action === 'like') {
                    response = { ok: likeCurrentReel(), pipActive: Boolean(document.pictureInPictureElement) };
                } else {
                    response = { ok: false, error: 'unsupported-command' };
                }
            } catch (error) {
                response = { ok: false, error: String(error?.message || error) };
            }

            window.postMessage({
                source: 'IG_REELS_PIP_MAIN_V1',
                requestId: msg.requestId,
                response,
            }, '*');
        });

        log('Ready: arrows while page is focused; Previous/Next media controls while backgrounded.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
