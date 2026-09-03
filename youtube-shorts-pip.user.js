// ==UserScript==
// @name         YouTube Shorts PiP Controls
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Native PiP controls for YouTube Shorts with reliable previous/next, auto-next, and like shortcut.
// @match        https://www.youtube.com/shorts/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[YT Shorts PiP]';
    const log = (...args) => console.log(TAG, ...args);
    const warn = (...args) => console.warn(TAG, ...args);

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

    function activeRenderer(video = currentShortVideo()) {
        if (video) {
            const renderer = video.closest('ytd-reel-video-renderer, ytd-shorts, [is-active]');
            if (renderer) return renderer;
        }
        return document.querySelector('ytd-reel-video-renderer[is-active], ytd-reel-video-renderer[active]') || null;
    }

    function currentShortVideo() {
        return document.pictureInPictureElement instanceof HTMLVideoElement
            ? document.pictureInPictureElement
            : (getMostVisibleVideo() || state.lastVideo);
    }

    function shortId() {
        return location.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || '';
    }

    function shortFingerprint(video = currentShortVideo()) {
        if (!(video instanceof HTMLVideoElement)) return '';
        const id = shortId();
        const src = video.currentSrc || video.src || '';
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
        return `${id}|${src}|${duration}`;
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
                    sleep(1200),
                ]);
            }
            await video.play().catch(() => {});
        } catch (_) {}
        return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    function installMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        const bind = (action, handler) => {
            try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
        };
        bind('nexttrack', () => switchShort('down', 'media-next'));
        bind('previoustrack', () => switchShort('up', 'media-previous'));
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
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        installMediaSessionHandlers();
    }

    async function enterPiP(video, reason = 'manual') {
        if (!video || !document.pictureInPictureEnabled || video.disablePictureInPicture) return false;
        await ensurePlayable(video);
        await primeMediaSessionForPiP(video);
        try {
            if (document.pictureInPictureElement !== video) await video.requestPictureInPicture();
            state.lastVideo = video;
            await video.play().catch(() => {});
            refreshMediaControls();
            log(`PiP active (${reason})`);
            return true;
        } catch (error) {
            warn('PiP failed', error?.name || error);
            return false;
        }
    }

    function navigationButton(direction) {
        const selectors = direction === 'down'
            ? [
                '#navigation-button-down button',
                'button[aria-label="Next video"]',
                'button[aria-label="Next"]',
                'yt-icon-button[aria-label="Next video"] button',
            ]
            : [
                '#navigation-button-up button',
                'button[aria-label="Previous video"]',
                'button[aria-label="Previous"]',
                'yt-icon-button[aria-label="Previous video"] button',
            ];
        for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button instanceof HTMLElement) return button;
        }
        return null;
    }

    function nudgeShorts(direction, currentVideo) {
        const button = navigationButton(direction);
        if (button) {
            button.click();
            return;
        }

        const renderer = activeRenderer(currentVideo);
        const sibling = direction === 'down' ? renderer?.nextElementSibling : renderer?.previousElementSibling;
        if (sibling instanceof HTMLElement) {
            sibling.scrollIntoView({ block: 'center', behavior: document.hidden ? 'auto' : 'smooth' });
            return;
        }

        window.scrollBy({ top: direction === 'down' ? innerHeight : -innerHeight, behavior: document.hidden ? 'auto' : 'smooth' });
    }

    async function resolveShortAfterMove(previousVideo, direction, timeoutMs = 10000) {
        const oldFingerprint = shortFingerprint(previousVideo);
        const oldPath = location.pathname;
        const started = performance.now();
        let nextNudgeAt = 0;

        while (performance.now() - started < timeoutMs) {
            const video = getMostVisibleVideo();
            if (video) {
                const changedPath = location.pathname !== oldPath;
                const changedVideo = video !== previousVideo || shortFingerprint(video) !== oldFingerprint;
                if ((changedPath || changedVideo) && visibleRatio(video) >= 0.30) return video;
            }

            const elapsed = performance.now() - started;
            if (elapsed >= nextNudgeAt) {
                nudgeShorts(direction, getMostVisibleVideo() || previousVideo);
                nextNudgeAt = elapsed + (document.hidden ? 850 : 500);
            }
            await sleep(document.hidden ? 140 : 80);
        }
        return null;
    }

    async function switchShort(direction, source = 'keyboard') {
        if (state.switching) {
            state.pendingDirection = direction;
            state.pendingSource = source;
            return true;
        }

        const current = currentShortVideo();
        if (!current) return false;
        state.switching = true;
        const token = ++state.switchToken;

        try {
            const target = await resolveShortAfterMove(current, direction);
            if (token !== state.switchToken || !target) return false;
            state.lastVideo = target;
            if (state.userEnabled || document.pictureInPictureElement) {
                await enterPiP(target, `switch:${source}`);
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
                if (queuedDirection) switchShort(queuedDirection, `${queuedSource || 'input'}:queued`);
            }, 180);
        }
    }

    function likeCurrentShort() {
        const renderer = activeRenderer();
        if (!renderer) return false;
        const selectors = [
            '#like-button button',
            'like-button-view-model button',
            'button[aria-label*="like this video" i]',
            'button[aria-label^="like" i]',
        ];
        for (const selector of selectors) {
            const button = renderer.querySelector(selector);
            if (!(button instanceof HTMLElement)) continue;
            if (button.getAttribute('aria-pressed') === 'true') return true;
            button.click();
            return true;
        }
        return false;
    }

    function maybeAutoAdvance(video, source) {
        if (!(video instanceof HTMLVideoElement) || !state.userEnabled) return;
        if (document.pictureInPictureElement !== video) return;
        const fingerprint = shortFingerprint(video);
        const now = performance.now();
        if (fingerprint === state.lastAutoNextFingerprint && now - state.lastAutoNextAt < 4000) return;
        state.lastAutoNextFingerprint = fingerprint;
        state.lastAutoNextAt = now;
        switchShort('down', `auto-${source}`);
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

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopImmediatePropagation();
            switchShort(event.key === 'ArrowDown' ? 'down' : 'up', 'arrow');
            return;
        }

        if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'l') {
            event.preventDefault();
            event.stopImmediatePropagation();
            likeCurrentShort();
        }
    }

    function createButton() {
        const existing = document.getElementById('yt-shorts-pip-button');
        if (existing) return existing;
        const button = document.createElement('button');
        button.id = 'yt-shorts-pip-button';
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
        const visible = location.pathname.startsWith('/shorts/') && allVideos().length > 0;
        if (state.button) state.button.style.display = visible ? 'block' : 'none';
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
            if (event.source !== window || !msg || msg.source !== 'YT_SHORTS_PIP_BRIDGE_V1') return;
            let response;
            try {
                if (msg.type === 'status') {
                    response = { ok: true, pipActive: Boolean(document.pictureInPictureElement), userEnabled: state.userEnabled };
                } else if (msg.type === 'switch' && (msg.direction === 'up' || msg.direction === 'down')) {
                    if (!document.pictureInPictureElement) response = { ok: false, pipActive: false, error: 'not-pip-owner' };
                    else response = { ok: await switchShort(msg.direction, 'extension-global'), pipActive: Boolean(document.pictureInPictureElement) };
                } else if (msg.type === 'action' && msg.action === 'like') {
                    response = { ok: likeCurrentShort(), pipActive: Boolean(document.pictureInPictureElement) };
                } else {
                    response = { ok: false, error: 'unsupported-command' };
                }
            } catch (error) {
                response = { ok: false, error: String(error?.message || error) };
            }
            window.postMessage({ source: 'YT_SHORTS_PIP_MAIN_V1', requestId: msg.requestId, response }, '*');
        });

        log('Ready');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
