/**
 * Glorious_E - Unified Combined Multi-Chat
 * Dynamic WebSocket & API client for Render.com & Localhost
 * With Clean Streamer Tag / Mention Highlight (@Glorious_E, @GloriousE, @glorious, Kick untagged)
 * Ignores automated bot accounts (Nightbot, Fossabot, StreamElements, etc.)
 */

(function() {
    'use strict';

    const CONFIG = {
        streamer: {
            kick: 'glorious_e',
            twitch: 'glorious_e',
            youtubeHandle: '@GloriousE',
            twitchUserId: '63304572'
        },
        defaultYtVideoId: 'hjuUwbPqkG8',
        maxMessagesInDom: 250
    };

    // Bots to ignore for @mentions
    const IGNORED_BOT_USERS = new Set([
        'nightbot',
        'fossabot',
        'streamelements',
        'streamlabs',
        'moobot',
        'botrix'
    ]);

    function isBotUser(username) {
        if (!username) return false;
        const normalized = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
        return IGNORED_BOT_USERS.has(normalized);
    }

    // State
    const state = {
        ytVideoId: null,
        ytTitle: 'Live Stream',
        ytIsLive: false,
        bridgeConnected: false,
        autoScroll: true,
        unreadCount: 0,
        mentionsOnly: false,
        filters: {
            kick: true,
            twitch: true,
            youtube: true
        },
        counts: {
            kick: 0,
            twitch: 0,
            youtube: 0,
            mentions: 0
        },
        fontSize: 14,
        seenMessageIds: new Set(),
        videoDrawerOpen: false,
        activeVideoPlayer: 'twitch',
        isTheater: false
    };

    // DOM Elements
    const elements = {
        appContainer: document.getElementById('appContainer'),
        chatFeed: document.getElementById('chatFeed'),
        chatScrollArea: document.getElementById('chatScrollArea'),
        jumpToBottomBtn: document.getElementById('jumpToBottomBtn'),
        jumpUnreadBadge: document.getElementById('jumpUnreadBadge'),
        
        // Status & badges
        connectionBadge: document.getElementById('connectionBadge'),
        ytStreamTitle: document.getElementById('ytStreamTitle'),
        ytIdBadge: document.getElementById('ytIdBadge'),
        btnDetectYt: document.getElementById('btnDetectYt'),
        ytUrlForm: document.getElementById('ytUrlForm'),
        ytUrlInput: document.getElementById('ytUrlInput'),
        
        // Filters
        filterKick: document.getElementById('filterKick'),
        filterTwitch: document.getElementById('filterTwitch'),
        filterYoutube: document.getElementById('filterYoutube'),
        filterMentions: document.getElementById('filterMentions'),
        countKick: document.getElementById('countKick'),
        countTwitch: document.getElementById('countTwitch'),
        countYoutube: document.getElementById('countYoutube'),
        countMentions: document.getElementById('countMentions'),
        
        // Tools
        btnClearChat: document.getElementById('btnClearChat'),
        btnToggleScroll: document.getElementById('btnToggleScroll'),
        btnFontMinus: document.getElementById('btnFontMinus'),
        btnFontPlus: document.getElementById('btnFontPlus'),
        btnToggleVideo: document.getElementById('btnToggleVideo'),
        btnTheater: document.getElementById('btnTheater'),
        btnExitTheater: document.getElementById('btnExitTheater'),
        
        // Video drawer
        videoDrawer: document.getElementById('videoDrawer'),
        videoFrame: document.getElementById('videoFrame'),
        playerTabBtns: document.querySelectorAll('.player-tab-btn'),
        
        toastContainer: document.getElementById('toastContainer')
    };

    // SVG Badges
    const ICONS = {
        kick: `<svg viewBox="0 0 24 24"><path d="M3 2h6v6h4V2h8v8h-6v4h6v8h-8v-6h-4v6H3V2z"/></svg>`,
        twitch: `<svg viewBox="0 0 24 24"><path d="M2.149 0l-1.612 4.119v16.804h5.331v3.077h3.201l3.198-3.077h4.802l6.932-6.928v-13.995h-21.851zm19.715 13.067l-3.734 3.731h-5.333l-3.2 3.077v-3.077h-3.731v-14.8h16v11.069z"/><path d="M17.884 5.334h-2.133v6.4h2.133v-6.4zm-5.334 0h-2.133v6.4h2.133v-6.4z"/></svg>`,
        youtube: `<svg viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`
    };

    /**
     * Intelligent detection of streamer mentions across Twitch, Kick, and YouTube:
     * - Twitch: @Glorious_E, @glorious_e, @Glorious
     * - YouTube: @GloriousE, @gloriouse
     * - Kick: @Glorious_E (manual tag), or bare 'glorious_e', 'gloriouse' (since Kick lacks user autocomplete)
     * - Direct address: "hey glorious", "yo glorious", "glorious, ...", "glorious: ..."
     * - Protects against false positives (e.g. "what a glorious raid" or URLs with clip/channel paths)
     */
    function isStreamerMentioned(text) {
        if (!text) return false;
        // Strip URLs before checking for streamer mention so a link to a clip or channel doesn't trigger mention alert
        const textWithoutUrls = text.replace(/https?:\/\/[^\s<]+/gi, '').trim();
        if (!textWithoutUrls) return false;

        // 1. Direct @ mention with any handle variation: @Glorious_E, @GloriousE, @glorious
        if (/@(?:glorious_e|gloriouse|glorious)\b/i.test(textWithoutUrls)) return true;

        // 2. Exact handle name with or without @ (glorious_e, gloriouse)
        if (/\b(?:glorious_e|gloriouse)\b/i.test(textWithoutUrls)) return true;

        // 3. Direct addressing of streamer with greeting or punctuation
        if (/\b(?:hey|yo|hi|hello|salut|coucou|gg|ggs|thanks|merci|ask|telling)\s+glorious\b/i.test(textWithoutUrls)) return true;
        if (/\bglorious\s*[:,?!~]/i.test(textWithoutUrls)) return true;
        if (/^\s*glorious\s+(?:did|do|can|are|is|will|have|what|how|why|when|where|who|you|u|bro|man|check|look|tell|pls|please)\b/i.test(textWithoutUrls)) return true;

        return false;
    }

    function showToast(msg, type = 'info') {
        if (!elements.toastContainer) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${msg}</span>`;
        elements.toastContainer.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 3200);
    }

    function formatTime(ts) {
        const d = ts ? new Date(ts) : new Date();
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Parse message text: URLs, mentions, emojis, Kick emotes, Twitch emotes, 7TV emotes.
     * Order is strictly preserved: URLs are placeholder-protected so mentions and emotes
     * can NEVER corrupt <a href="..."> attributes.
     * Single-pass mention replacer prevents double @@ or nested spans.
     * Ignores bots for streamer highlight styling.
     */
    function parseMessageContent(text, platform, rawEmotes, isBot = false) {
        if (!text) return '';
        let safe = escapeHtml(text);
        
        // 1. Extract URLs into temporary placeholders so mentions, emojis, and emotes never touch URL text or hrefs
        const urls = [];
        safe = safe.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
            const idx = urls.length;
            urls.push(match);
            return `___URL_${idx}___`;
        });

        // 2. Highlight @mentions in a SINGLE pass (avoids @@ or nested spans)
        safe = safe.replace(/@([a-zA-Z0-9_\u00A0-\uFFFF]+)|\b(glorious_e|gloriouse)\b/gi, (fullMatch, handleWithAt, bareHandle) => {
            if (handleWithAt) {
                const isStreamer = !isBot && /^(?:glorious_e|gloriouse|glorious)$/i.test(handleWithAt);
                if (isStreamer) {
                    return `<span class="chat-mention streamer-mention">@${handleWithAt}</span>`;
                }
                return `<span class="chat-mention">@${handleWithAt}</span>`;
            }
            if (bareHandle) {
                // If typed on Kick without '@', render cleanly once
                if (!isBot) {
                    return `<span class="chat-mention streamer-mention">@${bareHandle}</span>`;
                }
                return bareHandle;
            }
            return fullMatch;
        });

        // 3. YouTube Emojis (__YTEMOTE__:url:label__) - handles all emoji labels with underscores
        safe = safe.replace(/__YTEMOTE__:([^:]+):(.*?)__/g, (m, url, label) => {
            const decUrl = decodeURIComponent(url);
            const decLabel = decodeURIComponent(label);
            return `<img class="chat-emote" src="${escapeHtml(decUrl)}" alt="${escapeHtml(decLabel)}" title="${escapeHtml(decLabel)}">`;
        });

        // 4. Kick Native Emotes ([emote:ID:Name])
        safe = safe.replace(/\[emote:([0-9]+):([^\]]+)\]/g, (m, id, name) => {
            return `<img class="chat-emote" src="https://files.kick.com/emotes/${id}/fullsize" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`;
        });

        // 5. Twitch Native Emotes (from IRC tags)
        if (platform === 'twitch' && rawEmotes && typeof rawEmotes === 'string') {
            const parts = rawEmotes.split('/');
            for (const part of parts) {
                const [emoteId, ranges] = part.split(':');
                if (emoteId && ranges) {
                    const firstRange = ranges.split(',')[0];
                    const [start, end] = firstRange.split('-').map(Number);
                    if (!isNaN(start) && !isNaN(end) && end >= start) {
                        const emoteWord = text.substring(start, end + 1);
                        if (emoteWord) {
                            const escapedWord = escapeHtml(emoteWord);
                            const re = new RegExp('(^|\\s)' + escapedWord.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '(?=\\s|$)', 'g');
                            safe = safe.replace(re, `$1<img class="chat-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0" alt="${escapedWord}" title="${escapedWord}">`);
                        }
                    }
                }
            }
        }

        // 6. 7TV Emotes (Channel & Global 7TV Emote Sets)
        const emotesMap = window.SEVEN_TV_EMOTES || {};
        if (emotesMap && typeof emotesMap === 'object' && Object.keys(emotesMap).length > 0) {
            const tokens = safe.split(/(<[^>]+>|\s+)/);
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                if (!token.startsWith('<') && emotesMap[token]) {
                    tokens[i] = `<img class="chat-emote" src="${emotesMap[token]}" alt="${token}" title="${token}" loading="lazy">`;
                }
            }
            safe = tokens.join('');
        }

        // 7. Restore URLs as proper clickable <a> links
        safe = safe.replace(/___URL_(\d+)___/g, (m, idx) => {
            const u = urls[parseInt(idx, 10)];
            return `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
        });

        return safe;
    }

    /**
     * Append a message to the unified chat list
     */
    function appendMessage(msg) {
        if (!msg || !msg.message) return;
        
        // Deduplication
        if (msg.id && state.seenMessageIds.has(msg.id)) return;
        if (msg.id) state.seenMessageIds.add(msg.id);
        
        // Keep deduplication set bounded
        if (state.seenMessageIds.size > 1000) {
            const first = state.seenMessageIds.values().next().value;
            state.seenMessageIds.delete(first);
        }

        const platform = (msg.platform || 'twitch').toLowerCase();
        const isSelf = /^(?:glorious_e|gloriouse|glorious)$/i.test(msg.username || '');
        const isBot = isBotUser(msg.username);
        const isMentioned = !isSelf && !isBot && isStreamerMentioned(msg.message);
        const isFirstMsg = !!msg.firstMsg && platform === 'twitch';
        
        // Increment counts
        if (state.counts[platform] !== undefined) {
            state.counts[platform]++;
        }
        if (isMentioned) {
            state.counts.mentions++;
        }
        updateFilterBadges();

        const row = document.createElement('div');
        row.className = `chat-message-row platform-${platform}`;
        if (isMentioned) {
            row.classList.add('streamer-highlight');
        }
        if (isFirstMsg) {
            row.classList.add('twitch-first-chatter');
        }
        if (!state.filters[platform]) {
            row.classList.add('hidden-by-filter');
        }
        if (state.mentionsOnly && !isMentioned) {
            row.classList.add('hidden-by-mention-filter');
        }

        const timeStr = formatTime(msg.timestamp);
        const iconSvg = ICONS[platform] || ICONS.twitch;
        const color = msg.color || (platform === 'kick' ? '#00e701' : platform === 'twitch' ? '#a970ff' : '#ff4d4d');
        const safeUser = escapeHtml(msg.username || 'User');
        const parsedText = parseMessageContent(msg.message, platform, msg.rawEmotes, isBot);

        let avatarHtml = '';
        if (msg.avatar) {
            avatarHtml = `<img src="${escapeHtml(msg.avatar)}" alt="" class="chat-avatar" loading="lazy" onerror="this.style.display='none'">`;
        }

        let firstMsgHtml = '';
        if (isFirstMsg) {
            firstMsgHtml = `<span class="first-chatter-pill" title="First time chatting in channel">👋 First</span>`;
        }

        row.innerHTML = `
            <span class="chat-time">${timeStr}</span>
            <span class="platform-badge-pill ${platform}" title="${platform.toUpperCase()} Chat">
                ${iconSvg}
            </span>
            ${avatarHtml}
            <div class="chat-content-wrap">
                ${firstMsgHtml}<span class="chat-author" style="color:${color}">${safeUser}</span>:
                <span class="chat-text">${parsedText}</span>
            </div>
        `;

        elements.chatFeed.appendChild(row);

        // Prune old DOM elements to maintain high performance
        if (elements.chatFeed.children.length > CONFIG.maxMessagesInDom) {
            elements.chatFeed.removeChild(elements.chatFeed.firstElementChild);
        }

        // Auto-scroll logic
        if (state.autoScroll) {
            elements.chatScrollArea.scrollTop = elements.chatScrollArea.scrollHeight;
        } else {
            state.unreadCount++;
            updateUnreadBadge();
        }
    }

    function updateUnreadBadge() {
        if (state.unreadCount > 0) {
            elements.jumpUnreadBadge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
            elements.jumpToBottomBtn.classList.add('visible');
        } else {
            elements.jumpToBottomBtn.classList.remove('visible');
        }
    }

    function scrollToBottom() {
        elements.chatScrollArea.scrollTop = elements.chatScrollArea.scrollHeight;
        state.autoScroll = true;
        state.unreadCount = 0;
        updateUnreadBadge();
    }

    function updateFilterBadges() {
        if (elements.countKick) elements.countKick.textContent = state.counts.kick.toLocaleString();
        if (elements.countTwitch) elements.countTwitch.textContent = state.counts.twitch.toLocaleString();
        if (elements.countYoutube) elements.countYoutube.textContent = state.counts.youtube.toLocaleString();
        if (elements.countMentions) elements.countMentions.textContent = state.counts.mentions.toLocaleString();
    }

    function applyFilters() {
        document.querySelectorAll('.chat-message-row').forEach(row => {
            let isVisible = true;
            if (row.classList.contains('platform-kick') && !state.filters.kick) isVisible = false;
            if (row.classList.contains('platform-twitch') && !state.filters.twitch) isVisible = false;
            if (row.classList.contains('platform-youtube') && !state.filters.youtube) isVisible = false;
            row.classList.toggle('hidden-by-filter', !isVisible);

            // Filter mentions only
            if (state.mentionsOnly && !row.classList.contains('streamer-highlight')) {
                row.classList.add('hidden-by-mention-filter');
            } else {
                row.classList.remove('hidden-by-mention-filter');
            }
        });

        elements.filterKick.classList.toggle('active', state.filters.kick);
        elements.filterTwitch.classList.toggle('active', state.filters.twitch);
        elements.filterYoutube.classList.toggle('active', state.filters.youtube);
        if (elements.filterMentions) {
            elements.filterMentions.classList.toggle('active', state.counts.mentions > 0 || state.mentionsOnly);
            elements.filterMentions.classList.toggle('filtering-only', state.mentionsOnly);
        }
    }

    /**
     * Dynamic WebSocket connection supporting both HTTP (ws://) and HTTPS (wss://)
     */
    let bridgeWs = null;
    let bridgeReconnectTimer = null;

    function getBridgeWsUrl() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:8088';
        return `${proto}//${host}`;
    }

    function connectBridge() {
        const wsUrl = getBridgeWsUrl();
        console.log('[Bridge] Connecting to', wsUrl);
        
        try {
            bridgeWs = new WebSocket(wsUrl);

            bridgeWs.onopen = () => {
                console.log('[Bridge] Connected to unified multi-chat server!');
                state.bridgeConnected = true;
                updateConnectionStatus(true);
                clearTimeout(bridgeReconnectTimer);
            };

            bridgeWs.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'history' && Array.isArray(data.messages)) {
                        for (const m of data.messages) {
                            appendMessage(m);
                        }
                    } else if (data.platform && data.message) {
                        appendMessage(data);
                    }
                } catch (e) {
                    console.error('[Bridge] Error parsing frame', e);
                }
            };

            bridgeWs.onclose = () => {
                state.bridgeConnected = false;
                updateConnectionStatus(false);
                console.log('[Bridge] Disconnected. Reconnecting in 3s...');
                clearTimeout(bridgeReconnectTimer);
                bridgeReconnectTimer = setTimeout(connectBridge, 3000);
            };

            bridgeWs.onerror = () => {
                state.bridgeConnected = false;
                updateConnectionStatus(false);
            };
        } catch (e) {
            updateConnectionStatus(false);
            clearTimeout(bridgeReconnectTimer);
            bridgeReconnectTimer = setTimeout(connectBridge, 4000);
        }
    }

    function updateConnectionStatus(connected) {
        if (!elements.connectionBadge) return;
        if (connected) {
            elements.connectionBadge.className = 'connection-status-tag';
            elements.connectionBadge.innerHTML = '<span class="chip-dot" style="background:#10b981;box-shadow:0 0 6px #10b981;"></span> Live Multi-Chat Connected';
        } else {
            elements.connectionBadge.className = 'connection-status-tag offline';
            elements.connectionBadge.innerHTML = '<span class="chip-dot" style="background:#ef4444;"></span> Connecting Bridge...';
        }
    }

    /**
     * Auto-detect YouTube live stream
     */
    async function autoDetectYouTubeLive(force = false) {
        if (elements.btnDetectYt) {
            elements.btnDetectYt.disabled = true;
            elements.btnDetectYt.innerHTML = '🔄 Checking...';
        }

        try {
            const url = `/api/youtube${force ? '?force=1' : ''}`;
            const res = await fetch(url);
            const data = await res.json();

            if (data && data.videoId) {
                state.ytVideoId = data.videoId;
                state.ytTitle = data.title || 'Live Stream';
                state.ytIsLive = !!data.isLive;
                
                if (elements.ytIdBadge) elements.ytIdBadge.textContent = state.ytVideoId;
                if (elements.ytStreamTitle) elements.ytStreamTitle.textContent = state.ytTitle;
                
                fetch(`/api/set_yt?v=${encodeURIComponent(state.ytVideoId)}`).catch(()=>{});
                showToast(`YouTube stream detected: ${data.title || data.videoId}`, 'success');
            } else {
                showToast('No active YouTube stream detected. Keeping current.', 'info');
            }
        } catch (e) {
            showToast('Could not query YouTube status.', 'error');
        } finally {
            if (elements.btnDetectYt) {
                elements.btnDetectYt.disabled = false;
                elements.btnDetectYt.innerHTML = '🔄 Auto-Detect Live';
            }
        }
    }

    function parseYouTubeVideoId(input) {
        if (!input) return null;
        input = input.trim();
        if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
        const patterns = [
            /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|live\/|live_chat\?v=))([a-zA-Z0-9_-]{11})/i,
            /[?&]v=([a-zA-Z0-9_-]{11})/i
        ];
        for (const p of patterns) {
            const m = input.match(p);
            if (m && m[1]) return m[1];
        }
        return null;
    }

    /**
     * Video player drawer
     */
    function updateVideoPlayer(platform) {
        state.activeVideoPlayer = platform;
        elements.playerTabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.player === platform);
        });

        if (!state.videoDrawerOpen) return;

        let src = '';
        const host = window.location.hostname || 'localhost';
        if (platform === 'twitch') {
            src = `https://player.twitch.tv/?channel=${CONFIG.streamer.twitch}&parent=${host}&parent=localhost&parent=127.0.0.1&muted=false`;
        } else if (platform === 'kick') {
            src = `https://player.kick.com/${CONFIG.streamer.kick}?autoplay=true`;
        } else if (platform === 'youtube') {
            const vid = state.ytVideoId || CONFIG.defaultYtVideoId;
            src = `https://www.youtube.com/embed/${vid}?autoplay=1`;
        }
        elements.videoFrame.src = src;
    }

    function toggleVideoDrawer() {
        state.videoDrawerOpen = !state.videoDrawerOpen;
        elements.videoDrawer.classList.toggle('open', state.videoDrawerOpen);
        elements.btnToggleVideo.classList.toggle('active', state.videoDrawerOpen);
        if (state.videoDrawerOpen) {
            updateVideoPlayer(state.activeVideoPlayer);
        } else {
            elements.videoFrame.src = '';
        }
    }

    /**
     * Fetch & Cache 7TV Emotes
     */
    async function load7TvEmotes() {
        // Instant render from localStorage cache if available
        try {
            const cached = localStorage.getItem('7tv_emotes_cache');
            if (cached) {
                window.SEVEN_TV_EMOTES = JSON.parse(cached);
                console.log('[7TV] Loaded', Object.keys(window.SEVEN_TV_EMOTES).length, 'cached emotes');
            }
        } catch(e) {}

        // Fetch freshly from server
        try {
            const res = await fetch('/api/7tv_emotes');
            if (res.ok) {
                const emotes = await res.json();
                if (emotes && typeof emotes === 'object' && Object.keys(emotes).length > 0) {
                    window.SEVEN_TV_EMOTES = emotes;
                    try { localStorage.setItem('7tv_emotes_cache', JSON.stringify(emotes)); } catch(e) {}
                    console.log('[7TV] Loaded', Object.keys(emotes).length, 'emotes from /api/7tv_emotes');
                    return;
                }
            }
        } catch (err) {
            console.warn('[7TV] Failed fetching /api/7tv_emotes, trying 7TV CDN fallback', err);
        }

        // Direct 7TV CDN Fallback
        try {
            const emotes = {};
            const [chRes, glRes] = await Promise.all([
                fetch(`https://7tv.io/v3/users/twitch/${CONFIG.streamer.twitchUserId}`).then(r => r.json()).catch(() => null),
                fetch('https://7tv.io/v3/emote-sets/global').then(r => r.json()).catch(() => null)
            ]);

            if (chRes?.emote_set?.emotes) {
                for (const e of chRes.emote_set.emotes) {
                    if (e.name && e.data?.host?.url) emotes[e.name] = `https:${e.data.host.url}/2x.webp`;
                }
            }
            if (glRes?.emotes) {
                for (const e of glRes.emotes) {
                    if (e.name && e.data?.host?.url && !emotes[e.name]) emotes[e.name] = `https:${e.data.host.url}/2x.webp`;
                }
            }
            if (Object.keys(emotes).length > 0) {
                window.SEVEN_TV_EMOTES = emotes;
                try { localStorage.setItem('7tv_emotes_cache', JSON.stringify(emotes)); } catch(e) {}
                console.log('[7TV] Loaded', Object.keys(emotes).length, 'emotes from 7tv.io CDN');
            }
        } catch(e) {
            console.warn('[7TV] Fallback CDN failed', e);
        }
    }

    /**
     * Event Listeners
     */
    function setupEvents() {
        // Detect manual scrolling to pause auto-scroll
        elements.chatScrollArea.addEventListener('scroll', () => {
            const el = elements.chatScrollArea;
            const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            if (isNearBottom) {
                state.autoScroll = true;
                state.unreadCount = 0;
                updateUnreadBadge();
            } else {
                state.autoScroll = false;
            }
        });

        // Jump to bottom click
        elements.jumpToBottomBtn.addEventListener('click', scrollToBottom);

        // Platform Filter Chips
        elements.filterKick.addEventListener('click', () => {
            state.filters.kick = !state.filters.kick;
            applyFilters();
        });
        elements.filterTwitch.addEventListener('click', () => {
            state.filters.twitch = !state.filters.twitch;
            applyFilters();
        });
        elements.filterYoutube.addEventListener('click', () => {
            state.filters.youtube = !state.filters.youtube;
            applyFilters();
        });

        // Mentions Filter Chip
        if (elements.filterMentions) {
            elements.filterMentions.addEventListener('click', () => {
                state.mentionsOnly = !state.mentionsOnly;
                applyFilters();
                showToast(state.mentionsOnly ? 'Filtering: Showing only messages tagging Glorious_E' : 'Showing all messages', 'info');
            });
        }

        // Clear Chat
        elements.btnClearChat.addEventListener('click', () => {
            elements.chatFeed.innerHTML = '';
            state.seenMessageIds.clear();
            state.unreadCount = 0;
            updateUnreadBadge();
            showToast('Chat cleared', 'info');
        });

        // Toggle Auto-Scroll
        elements.btnToggleScroll.addEventListener('click', () => {
            state.autoScroll = !state.autoScroll;
            elements.btnToggleScroll.classList.toggle('active', state.autoScroll);
            if (state.autoScroll) scrollToBottom();
            showToast(`Auto-scroll ${state.autoScroll ? 'enabled' : 'paused'}`, 'info');
        });

        // Font Size Adjusters
        elements.btnFontMinus.addEventListener('click', () => {
            if (state.fontSize > 11) {
                state.fontSize -= 1;
                document.documentElement.style.setProperty('--chat-font-size', state.fontSize + 'px');
            }
        });
        elements.btnFontPlus.addEventListener('click', () => {
            if (state.fontSize < 22) {
                state.fontSize += 1;
                document.documentElement.style.setProperty('--chat-font-size', state.fontSize + 'px');
            }
        });

        // Detect YouTube Live
        elements.btnDetectYt.addEventListener('click', () => autoDetectYouTubeLive(true));

        // Submit manual YouTube URL
        elements.ytUrlForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const val = elements.ytUrlInput.value.trim();
            const vid = parseYouTubeVideoId(val);
            if (vid) {
                state.ytVideoId = vid;
                state.ytTitle = `Custom Stream (${vid})`;
                if (elements.ytIdBadge) elements.ytIdBadge.textContent = vid;
                if (elements.ytStreamTitle) elements.ytStreamTitle.textContent = state.ytTitle;
                elements.ytUrlInput.value = '';
                fetch(`/api/set_yt?v=${encodeURIComponent(vid)}`).catch(()=>{});
                showToast(`Set YouTube Stream ID: ${vid}`, 'success');
            } else {
                showToast('Invalid YouTube URL or ID!', 'error');
            }
        });

        // Toggle Video Drawer
        elements.btnToggleVideo.addEventListener('click', toggleVideoDrawer);
        elements.playerTabBtns.forEach(btn => {
            btn.addEventListener('click', () => updateVideoPlayer(btn.dataset.player));
        });

        // Fullscreen / Theater
        const toggleTheater = () => {
            state.isTheater = !state.isTheater;
            elements.appContainer.classList.toggle('theater', state.isTheater);
        };
        elements.btnTheater.addEventListener('click', toggleTheater);
        elements.btnExitTheater.addEventListener('click', toggleTheater);

        // Keyboard Shortcuts (ignores when Ctrl, Alt, or Meta is pressed)
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            // Never interfere with Ctrl+C (copy), Ctrl+A, Ctrl+V, etc.
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                toggleTheater();
            } else if (e.key === 'x' || e.key === 'X' || e.key === 'Delete') {
                elements.btnClearChat.click();
            } else if (e.key === '1') {
                elements.filterKick.click();
            } else if (e.key === '2') {
                elements.filterTwitch.click();
            } else if (e.key === '3') {
                elements.filterYoutube.click();
            } else if (e.key === '4') {
                if (elements.filterMentions) elements.filterMentions.click();
            }
        });
    }

    /**
     * Bootstrap App
     */
    function init() {
        // Read preloaded YouTube ID
        const initialIdEl = document.getElementById('initialYtVideoId');
        if (initialIdEl && initialIdEl.value) {
            state.ytVideoId = initialIdEl.value;
        } else {
            state.ytVideoId = CONFIG.defaultYtVideoId;
        }

        const initialTitleEl = document.getElementById('initialYtTitle');
        if (initialTitleEl && initialTitleEl.value) {
            state.ytTitle = initialTitleEl.value;
        }

        setupEvents();

        // 1. Load 7TV Emotes
        load7TvEmotes();

        // 2. Connect to the WebSocket server
        connectBridge();

        // 3. Auto-detect today's YouTube stream
        autoDetectYouTubeLive(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
