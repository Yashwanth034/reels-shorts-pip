// ==UserScript==
// @name         TikTok PiP Controls
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Native PiP controls for TikTok with previous/next, auto-next, like shortcut, and background-safe playback.
// @match        https://www.tiktok.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[TikTok PiP]';
    const log = (...args) => console.log(TAG, ...args);
    const warn = (...args) => console.warn(TAG, ...args);
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
        lastAutoNextFingerprint: '',
        lastAutoNextAt: 0,
    };

    function allVideos() {
        return Array.from(document.querySelectorAll('video')).filter(video => video.isConnected);
    }

    function visibleRatio(video) {
        const rect = video.getBoundingClientRect();
        const total = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (!total) return 0;
        const left = Math.max(0, rect.left);
        const right = Math.min(innerWidth, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(innerHeight, rect.bottom);
        const visible = Math.max(0, right - left) * Math.max(0, bottom - top);
        return visible / total;
    }

    function getMostVisibleVideo() {
        const videos = allVideos();
        if (!videos.length) return null;
        return videos.sort((a, b) => visibleRatio(b) - visibleRatio(a))[0] || null;
    }

    function currentVideo() {
        return document.pictureInPictureElement instanceof HTMLVideoElement
            ? document.pictureInPictureElement
            : (getMostVisibleVideo() || state.lastVideo);
    }

    function videoContainer(video = currentVideo()) {
        if (!(video instanceof HTMLVideoElement)) return null;
        return video.closest(
            'article[data-e2e="recommend-list-item-container"], ' +
            'div[data-e2e="recommend-list-item-container"], ' +
            '[data-e2e="browse-video"], [data-e2e="feed-video"]'
        ) || video.parentElement;
    }

    function postHref(video = currentVideo()) {
        const container = videoContainer(video);
        const anchor = container?.querySelector?.('a[href*="/video/"]')
            || video?.closest?.('a[href*="/video/"]')
            || document.querySelector('a[href*="/video/"][aria-current="page"]');
        if (anchor?.href) {
            try {
                const url = new URL(anchor.href, location.href);
                return url.pathname;
            } catch (_) {}
        }
        return /\/video\/\d+/.test(location.pathname) ? location.pathname : '';
    }

    function fingerprint(video = currentVideo()) {
        if (!(video instanceof HTMLVideoElement)) return '';
        const href = postHref(video);
        const src = video.currentSrc || video.src || '';
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
        return `${href}|${src}|${duration}`;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function ensurePlayable(video) {
        if (!video) return false;
        try {
            if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                await Promise.race([
                    new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })),
                    sleep(1500),
                ]);
            }
            await video.play().catch(() => {});
        } catch (_) {}
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    function pauseOtherVideos(keep) {
        for (const video of allVideos()) {
            if (video === keep || video.paused) continue;
            try { nativePause.call(video); } catch (_) {}
        }
    }

    HTMLMediaElement.prototype.pause = function (...args) {
        const isActivePiPVideo = this instanceof HTMLVideoElement
            && state.userEnabled
            && document.pictureInPictureElement === this;
        if (isActivePiPVideo) {
            log('Blocked TikTok scripted pause() on active PiP video');
            return;
        }
        return nativePause.apply(this, args);
    };

    document.addEventListener('visibilitychange', event => {
        if (!state.userEnabled || !(document.pictureInPictureElement instanceof HTMLVideoElement)) return;
        refreshMediaControls();
        event.stopImmediatePropagation();
    }, true);

    document.addEventListener('play', event => {
        const video = event.target;
        const pipVideo = document.pictureInPictureElement;
        if (!(video instanceof HTMLVideoElement) || !(pipVideo instanceof HTMLVideoElement)) return;
        if (!state.userEnabled || video === pipVideo) return;
        try { nativePause.call(video); } catch (_) {}
    }, true);

    function installMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        const bind = (action, handler) => {
            try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
        };
        bind('nexttrack', () => switchVideo('down', 'media-next'));
        bind('previoustrack', () => switchVideo('up', 'media-previous'));
    }

    function refreshMediaControls() {
        installMediaSessionHandlers();
        for (const delay of [60, 180, 500]) setTimeout(installMediaSessionHandlers, delay);
    }

    async function primeMediaSessionForPiP(video) {
        installMediaSessionHandlers();
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing'; } catch (_) {}
        }
        await Promise.race([
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            sleep(200),
        ]);
        installMediaSessionHandlers();
    }

    async function enterPiP(video, reason = 'manual') {
        if (!video || !document.pictureInPictureEnabled || video.disablePictureInPicture) return false;
        await ensurePlayable(video);
        pauseOtherVideos(video);
        await primeMediaSessionForPiP(video);
        try {
            if (document.pictureInPictureElement !== video) await video.requestPictureInPicture();
            state.lastVideo = video;
            await video.play().catch(() => {});
            pauseOtherVideos(video);
            refreshMediaControls();
            log(`PiP active (${reason})`);
            return true;
        } catch (error) {
            warn('PiP failed', error?.name || error);
            return false;
        }
    }

    function visibleButton(selector) {
        return Array.from(document.querySelectorAll(selector)).find(button => {
            if (!(button instanceof HTMLElement)) return false;
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== 'hidden';
        }) || null;
    }

    function detailArrow(direction) {
        const selector = direction === 'down'
            ? 'button[data-e2e="arrow-right"]'
            : 'button[data-e2e="arrow-left"]';
        return visibleButton(selector);
    }

    function feedContainers() {
        const selectors = [
            'article[data-e2e="recommend-list-item-container"]',
            'div[data-e2e="recommend-list-item-container"]',
        ];
        const seen = new Set();
        const items = [];
        for (const selector of selectors) {
            for (const item of document.querySelectorAll(selector)) {
                if (!(item instanceof HTMLElement) || seen.has(item)) continue;
                if (!item.querySelector('video')) continue;
                seen.add(item);
                items.push(item);
            }
        }
        return items;
    }

    function nudge(direction, previousVideo) {
        if (/\/video\/\d+/.test(location.pathname)) {
            const arrow = detailArrow(direction);
            if (arrow) {
                arrow.click();
                return;
            }
        }

        const current = videoContainer(previousVideo);
        const items = feedContainers();
        const index = items.indexOf(current);
        if (index >= 0) {
            const target = items[index + (direction === 'down' ? 1 : -1)];
            if (target instanceof HTMLElement) {
                target.scrollIntoView({ block: 'center', behavior: 'auto' });
                return;
            }
        }

        const videos = allVideos().sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (ar.top + ar.height / 2) - (br.top + br.height / 2);
        });
        const currentIndex = videos.indexOf(previousVideo);
        const targetVideo = videos[currentIndex + (direction === 'down' ? 1 : -1)];
        if (targetVideo instanceof HTMLVideoElement) {
            targetVideo.scrollIntoView({ block: 'center', behavior: 'auto' });
            return;
        }

        window.scrollBy({
            top: direction === 'down' ? Math.max(innerHeight * 0.9, 500) : -Math.max(innerHeight * 0.9, 500),
            behavior: 'auto',
        });
    }

    async function resolveAfterMove(previousVideo, direction, timeoutMs = 10000) {
        const oldFingerprint = fingerprint(previousVideo);
        const oldPath = location.pathname;
        const started = performance.now();
        let nextNudgeAt = 0;

        while (performance.now() - started < timeoutMs) {
            const video = getMostVisibleVideo();
            if (video) {
                const changedPath = location.pathname !== oldPath;
                const changedVideo = video !== previousVideo || fingerprint(video) !== oldFingerprint;
                if ((changedPath || changedVideo) && visibleRatio(video) >= 0.25) return video;
            }

            const elapsed = performance.now() - started;
            if (elapsed >= nextNudgeAt) {
                nudge(direction, getMostVisibleVideo() || previousVideo);
                nextNudgeAt = elapsed + (document.hidden ? 900 : 550);
            }
            await sleep(document.hidden ? 150 : 90);
        }

        return null;
    }

    async function switchVideo(direction, source = 'keyboard') {
        if (state.switching) {
            state.pendingDirection = direction;
            state.pendingSource = source;
            return true;
        }

        const current = currentVideo();
        if (!current) return false;
        state.switching = true;
        const token = ++state.switchToken;

        try {
            const target = await resolveAfterMove(current, direction);
            if (token !== state.switchToken || !target) return false;
            state.lastVideo = target;
            if (state.userEnabled || document.pictureInPictureElement) {
                const ok = await enterPiP(target, `switch:${source}`);
                if (!ok) return false;
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
                if (queuedDirection) switchVideo(queuedDirection, `${queuedSource || 'input'}:queued`);
            }, 180);
        }
    }

    function likeButton() {
        const root = videoContainer() || document;
        const directSelectors = [
            'button[data-e2e="like-icon"]',
            'button[data-e2e="browse-like-icon"]',
            'button[aria-label*="like" i]',
        ];

        for (const selector of directSelectors) {
            const button = root.querySelector(selector);
            if (button instanceof HTMLButtonElement) return button;
        }

        for (const button of root.querySelectorAll('button')) {
            if (!(button instanceof HTMLButtonElement)) continue;
            if (button.querySelector('[data-e2e="browse-like-icon"], [data-e2e="like-icon"], [data-e2e*="liked"]')) {
                return button;
            }
        }

        return null;
    }

    function likeCurrentVideo() {
        const button = likeButton();
        if (!button) return false;
        const label = String(button.getAttribute('aria-label') || '').toLowerCase();
        if (button.getAttribute('aria-pressed') === 'true' || label.includes('unlike')) return true;
        if (button.querySelector('[data-e2e*="liked"]')) return true;
        button.click();
        return true;
    }

    function maybeAutoAdvance(video, source) {
        if (!(video instanceof HTMLVideoElement) || !state.userEnabled) return;
        if (document.pictureInPictureElement !== video) return;
        const key = fingerprint(video);
        const now = performance.now();
        if (key === state.lastAutoNextFingerprint && now - state.lastAutoNextAt < 4000) return;
        state.lastAutoNextFingerprint = key;
        state.lastAutoNextAt = now;
        switchVideo('down', `auto-${source}`);
    }

    function handleEnded(event) {
        maybeAutoAdvance(event.target, 'ended');
    }

    function handleProgress(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement) || video.paused) return;
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;
        if (video.currentTime < Math.max(0, video.duration - 0.18)) return;
        maybeAutoAdvance(video, 'near-end');
    }

    function keyboardHandler(event) {
        if (event.defaultPrevented) return;
        const target = event.target;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

        if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            switchVideo(event.key === 'ArrowDown' ? 'down' : 'up', 'arrow');
            return;
        }

        if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'l') {
            event.preventDefault();
            event.stopImmediatePropagation();
            likeCurrentVideo();
        }
    }

    function createButton() {
        const existing = document.getElementById('tiktok-pip-button');
        if (existing) return existing;

        const button = document.createElement('button');
        button.id = 'tiktok-pip-button';
        button.type = 'button';
        button.textContent = '⏏ PiP';
        Object.assign(button.style, {
            position: 'fixed', bottom: '90px', right: '20px', zIndex: '2147483647',
            background: 'rgba(0,0,0,.86)', color: '#fff', border: '2px solid #fff',
            padding: '11px 17px', borderRadius: '999px', cursor: 'pointer',
            fontSize: '15px', fontWeight: '700', fontFamily: 'system-ui,sans-serif',
            boxShadow: '0 4px 16px rgba(0,0,0,.45)', display: 'none', userSelect: 'none',
        });

        button.addEventListener('click', async () => {
            const video = getMostVisibleVideo();
            if (!video) return;
            state.userEnabled = true;
            state.lastVideo = video;
            const ok = await enterPiP(video, 'manual');
            if (!ok) state.userEnabled = false;
        });

        document.body.appendChild(button);
        return button;
    }

    function updateUi() {
        if (state.button) state.button.style.display = allVideos().length ? 'block' : 'none';
    }

    function init() {
        if (!document.body) return;

        state.button = createButton();
        window.addEventListener('keydown', keyboardHandler, { capture: true, passive: false });
        installMediaSessionHandlers();
        document.addEventListener('ended', handleEnded, true);
        document.addEventListener('timeupdate', handleProgress, true);

        document.addEventListener('enterpictureinpicture', event => {
            if (event.target instanceof HTMLVideoElement) {
                state.lastVideo = event.target;
                refreshMediaControls();
            }
        }, true);

        document.addEventListener('leavepictureinpicture', () => {
            if (state.switching) return;
            setTimeout(() => {
                if (!document.pictureInPictureElement && !state.switching) state.userEnabled = false;
            }, 180);
        }, true);

        state.observer = new MutationObserver(() => {
            updateUi();
            clearTimeout(state.mediaRefreshTimer);
            state.mediaRefreshTimer = setTimeout(installMediaSessionHandlers, 120);
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
        updateUi();

        window.addEventListener('message', async event => {
            const msg = event.data;
            if (event.source !== window || !msg || msg.source !== 'TIKTOK_PIP_BRIDGE_V1') return;

            let response;
            try {
                if (msg.type === 'status') {
                    response = { ok: true, pipActive: Boolean(document.pictureInPictureElement), userEnabled: state.userEnabled };
                } else if (msg.type === 'switch' && (msg.direction === 'up' || msg.direction === 'down')) {
                    if (!document.pictureInPictureElement) response = { ok: false, pipActive: false, error: 'not-pip-owner' };
                    else response = { ok: await switchVideo(msg.direction, 'extension-global'), pipActive: Boolean(document.pictureInPictureElement) };
                } else if (msg.type === 'action' && msg.action === 'like') {
                    response = { ok: likeCurrentVideo(), pipActive: Boolean(document.pictureInPictureElement) };
                } else {
                    response = { ok: false, error: 'unsupported-command' };
                }
            } catch (error) {
                response = { ok: false, error: String(error?.message || error) };
            }

            window.postMessage({
                source: 'TIKTOK_PIP_MAIN_V1',
                requestId: msg.requestId,
                response,
            }, '*');
        });

        log('Ready');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
