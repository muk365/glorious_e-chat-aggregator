/**
 * Glorious_E - Unified Multi-Chat Full Server (Render.com ready)
 * Static File Server + REST API + Real-Time WebSocket Bridge
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Port from Render environment or local 8088
const PORT = process.env.PORT || 8088;

const STREAMER = {
    twitch: 'glorious_e',
    twitchUserId: '63304572',
    kickChatroomId: 7457099,
    youtubeHandle: '@GloriousE',
    youtubeChannelId: 'UCt-78v3wvyWLNORSDRiWkyg',
    defaultYtVideoId: 'y2I6AtvDqyk'
};

let ytApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Automated bot users to ignore for all highlights
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

// Twitch OAuth Credentials (configured in Render.com environment)
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

// User OAuth sessions & CSRF state maps
const userSessions = new Map(); // sessionId -> { sessionId, accessToken, refreshToken, expiresAt, user: { id, login, displayName, avatar } }
const oauthStates = new Map();  // stateToken -> timestamp

// Global state
let currentYtVideoId = STREAMER.defaultYtVideoId;
let currentYtTitle = 'Live Stream';
let currentYtIsLive = false;
let recentMessages = [];
const MAX_HISTORY = 1200;
const MAX_HIGHLIGHT_HISTORY = 500;
const recentHighlights = []; // dedicated buffer so subs and highlights are never lost on reload
const wsClients = new Set();

// In-memory caches with TTL
const cache = {
    youtube: { data: null, expires: 0 },
    emotes7tv: { data: null, expires: 0 },
    kick: { data: null, expires: 0 },
    twitch: { data: null, expires: 0 }
};

// Map of pending first-time chatter introduction notices (username -> expiry timestamp)
const pendingFirstChatters = new Map();

// Prevent EPIPE crash if output stream closes
process.stdout?.on('error', (err) => { if (err.code === 'EPIPE') return; });
process.stderr?.on('error', (err) => { if (err.code === 'EPIPE') return; });

function addMessage(msg) {
    if (!msg || !msg.message) return;
    msg.id = msg.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    msg.timestamp = msg.timestamp || Date.now();
    
    recentMessages.push(msg);
    if (recentMessages.length > MAX_HISTORY) {
        recentMessages.shift();
    }

    // Keep dedicated history of support events (subs, bits) and first-time chatters
    if (msg.subEvent || msg.firstMsg) {
        recentHighlights.push(msg);
        if (recentHighlights.length > MAX_HIGHLIGHT_HISTORY) {
            recentHighlights.shift();
        }
    }
    
    broadcast(msg);
}

function getFullHistory() {
    const combined = [];
    const seen = new Set();
    for (const m of recentHighlights) {
        if (m && m.id && !seen.has(m.id)) {
            seen.add(m.id);
            combined.push(m);
        }
    }
    for (const m of recentMessages) {
        if (m && m.id && !seen.has(m.id)) {
            seen.add(m.id);
            combined.push(m);
        }
    }
    combined.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return combined;
}

function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of wsClients) {
        try {
            sendWsFrame(client, payload);
        } catch (e) {
            wsClients.delete(client);
        }
    }
}

function sendWsFrame(socket, text) {
    if (socket.destroyed || !socket.writable) return;
    const buffer = Buffer.from(text);
    const len = buffer.length;
    let header;
    
    if (len <= 125) {
        header = Buffer.from([0x81, len]);
    } else if (len <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    
    socket.write(Buffer.concat([header, buffer]));
}

// ==========================================
// 1. API: YOUTUBE LIVE DETECTOR
// ==========================================
async function getYouTubeLiveStatus(force = false) {
    const now = Date.now();
    if (!force && cache.youtube.data && cache.youtube.expires > now) {
        return cache.youtube.data;
    }
    
    try {
        let videoId = null;
        let title = 'Live Stream';
        let isLive = false;

        // Method 1: YouTube Innertube Browse API (targeted directly at Glorious_E's streams tab)
        // This is a direct JSON API that is never redirected to the YouTube homepage!
        try {
            const innerRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${ytApiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                },
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'WEB',
                            clientVersion: '2.20240410.01.00'
                        }
                    },
                    browseId: STREAMER.youtubeChannelId,
                    params: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D'
                })
            });

            if (innerRes.ok) {
                const innerData = await innerRes.json();
                const innerStr = JSON.stringify(innerData);
                
                // Match the LIVE badge targetId on Glorious_E's streams tab
                const liveBadgeMatch = innerStr.match(/"text":"LIVE"[^}]+?"animationActivationTargetId":"([a-zA-Z0-9_-]{11})"/);
                if (liveBadgeMatch) {
                    videoId = liveBadgeMatch[1];
                    isLive = true;
                }
            }
        } catch (innerErr) {
            console.warn('[YouTube Live] Innertube browse failed:', innerErr.message);
        }

        // Method 2: Direct channel /live and /streams scraping (only if Method 1 did not find video)
        if (!videoId) {
            const endpoints = [
                `https://www.youtube.com/${STREAMER.youtubeHandle}/live?ucbcb=1`,
                `https://www.youtube.com/channel/${STREAMER.youtubeChannelId}/live?ucbcb=1`,
                `https://www.youtube.com/${STREAMER.youtubeHandle}/streams?ucbcb=1`,
                `https://www.youtube.com/channel/${STREAMER.youtubeChannelId}/streams?ucbcb=1`
            ];

            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'SOCS=CAESEwgDEgk2OTQ0MjAyNjEaAmVuIAEaBgiA_LyaBg; CONSENT=PENDING+999; YES=1'
            };

            for (const ep of endpoints) {
                try {
                    const res = await fetch(ep, {
                        headers: reqHeaders,
                        redirect: 'follow'
                    });

                    // Reject any request that was redirected to the generic YouTube homepage or consent interstitial!
                    if (res.url.endsWith('youtube.com/') || res.url.includes('consent.youtube.com')) {
                        continue;
                    }

                    const html = await res.text();

                    // Canonical tag pointing to watch?v=
                    const canonMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
                    if (canonMatch) {
                        videoId = canonMatch[1];
                    }

                    // OpenGraph / Twitter meta tags
                    if (!videoId) {
                        const ogMatch = html.match(/<meta property="og:url" content="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
                        if (ogMatch) videoId = ogMatch[1];
                    }

                    // Streams tab LIVE badge
                    if (!videoId) {
                        const liveBadgeMatch = html.match(/"text":"LIVE"[^}]+?"animationActivationTargetId":"([a-zA-Z0-9_-]{11})"/);
                        if (liveBadgeMatch) videoId = liveBadgeMatch[1];
                    }

                    const hasLiveTag = html.includes('"isLive":true') ||
                                       html.includes('"isLiveNow":true') ||
                                       html.includes('"isLiveContent":true') ||
                                       html.includes('"text":"LIVE"') ||
                                       html.includes('THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE') ||
                                       html.includes('BADGE_STYLE_TYPE_LIVE_NOW');

                    if (videoId) {
                        isLive = hasLiveTag;
                        break;
                    }
                } catch (epErr) {
                    console.warn(`[YouTube Live] Endpoint ${ep} failed:`, epErr.message);
                }
            }
        }

        // MANDATORY VALIDATION: Verify candidate video strictly belongs to Glorious_E via oEmbed
        if (videoId) {
            try {
                const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                if (oembedRes.ok) {
                    const oembedData = await oembedRes.json();
                    const author = String(oembedData.author_name || '').toLowerCase();
                    const authorUrl = String(oembedData.author_url || '').toLowerCase();
                    const isGlorious = author.includes('glorious') || authorUrl.includes('gloriouse');

                    if (isGlorious) {
                        title = oembedData.title || title;
                    } else {
                        console.warn(`[YouTube Live] Rejected video ${videoId} because author "${oembedData.author_name}" does not match Glorious_E`);
                        videoId = null;
                        isLive = false;
                    }
                }
            } catch (oErr) {
                console.warn('[YouTube Live] oEmbed validation warning:', oErr.message);
            }
        }

        if (videoId && isLive) {
            const changed = (videoId !== currentYtVideoId);
            currentYtVideoId = videoId;
            currentYtTitle = title;
            currentYtIsLive = true;
            if (changed) {
                ytContinuation = null;
                pollYouTubeChat();
            }
        } else {
            // Keep default/current video if live is not detected
            videoId = currentYtVideoId || STREAMER.defaultYtVideoId;
            isLive = false;
        }

        const result = {
            success: true,
            channel: STREAMER.youtubeHandle,
            videoId: currentYtVideoId,
            title: currentYtTitle,
            isLive: currentYtIsLive,
            checkedAt: new Date().toISOString()
        };
        
        cache.youtube.data = result;
        cache.youtube.expires = now + 120000; // 2 min
        return result;
    } catch (e) {
        return {
            success: false,
            videoId: currentYtVideoId || STREAMER.defaultYtVideoId,
            title: currentYtTitle,
            isLive: currentYtIsLive,
            error: e.message
        };
    }
}

// ==========================================
// 2. API: 7TV EMOTES FETCHER
// ==========================================
async function get7TvEmotes(force = false) {
    const now = Date.now();
    if (!force && cache.emotes7tv.data && cache.emotes7tv.expires > now) {
        return cache.emotes7tv.data;
    }
    
    const emotes = {};
    try {
        // Channel emotes
        const chRes = await fetch(`https://7tv.io/v3/users/twitch/${STREAMER.twitchUserId}`);
        const chData = await chRes.json();
        for (const e of (chData?.emote_set?.emotes || [])) {
            const name = e.name;
            const hostUrl = e.data?.host?.url;
            if (name && hostUrl) {
                emotes[name] = `https:${hostUrl}/2x.webp`;
            }
        }
        
        // Global emotes
        const glRes = await fetch('https://7tv.io/v3/emote-sets/global');
        const glData = await glRes.json();
        for (const e of (glData?.emotes || [])) {
            const name = e.name;
            const hostUrl = e.data?.host?.url;
            if (name && hostUrl && !emotes[name]) {
                emotes[name] = `https:${hostUrl}/2x.webp`;
            }
        }
        
        cache.emotes7tv.data = emotes;
        cache.emotes7tv.expires = now + (24 * 60 * 60 * 1000); // 24h
        return emotes;
    } catch (e) {
        console.warn('[7TV] Error fetching emotes:', e.message);
        return cache.emotes7tv.data || {};
    }
}

// ==========================================
// 3. API: KICK & TWITCH LIVE STATUS
// ==========================================
async function getKickStatus() {
    const now = Date.now();
    if (cache.kick.data && cache.kick.expires > now) return cache.kick.data;
    try {
        const res = await fetch(`https://kick.com/api/v2/channels/${STREAMER.twitch}`);
        const json = await res.json();
        const live = json.livestream;
        const result = {
            isLive: !!live?.is_live,
            viewers: live?.viewer_count || 0,
            title: live?.session_title || null,
            category: live?.categories?.[0]?.name || 'Escape From Tarkov',
            avatar: json.user?.profile_pic || null
        };
        cache.kick.data = result;
        cache.kick.expires = now + 60000;
        return result;
    } catch (e) {
        return { isLive: false, viewers: 0 };
    }
}

async function getTwitchStatus() {
    const now = Date.now();
    if (cache.twitch.data && cache.twitch.expires > now) return cache.twitch.data;
    try {
        const query = JSON.stringify({
            query: `query { user(login: "${STREAMER.twitch}") { displayName profileImageURL(width: 70) stream { viewersCount title game { name } } } }`
        });
        const res = await fetch('https://gql.twitch.tv/gql', {
            method: 'POST',
            headers: {
                'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                'Content-Type': 'application/json'
            },
            body: query
        });
        const json = await res.json();
        const user = json.data?.user;
        const stream = user?.stream;
        const result = {
            isLive: !!stream,
            viewers: stream?.viewersCount || 0,
            title: stream?.title || null,
            category: stream?.game?.name || 'Escape from Tarkov',
            avatar: user?.profileImageURL || null
        };
        cache.twitch.data = result;
        cache.twitch.expires = now + 60000;
        return result;
    } catch (e) {
        return { isLive: false, viewers: 0 };
    }
}

// ==========================================
// 4. BACKGROUND CHAT CONNECTORS
// ==========================================
// Twitch IRC
let twitchWs = null;
function initTwitch() {
    try {
        twitchWs = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        twitchWs.onopen = () => {
            twitchWs.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
            twitchWs.send('PASS SCHMOOPIE');
            twitchWs.send('NICK justinfan' + Math.floor(10000 + Math.random() * 89999));
            twitchWs.send('JOIN #' + STREAMER.twitch);
        };
        twitchWs.onmessage = (event) => {
            const lines = event.data.split('\r\n');
            for (const line of lines) {
                if (!line) continue;
                if (line.startsWith('PING')) {
                    twitchWs.send('PONG :tmi.twitch.tv');
                    continue;
                }
                if (line.includes('PRIVMSG')) {
                    parseTwitchPrivmsg(line);
                } else if (line.includes('USERNOTICE')) {
                    parseTwitchUsernotice(line);
                }
            }
        };
        twitchWs.onclose = () => setTimeout(initTwitch, 4000);
        twitchWs.onerror = () => {};
    } catch (e) {
        setTimeout(initTwitch, 5000);
    }
}

function parseTwitchPrivmsg(raw) {
    const tagsMatch = raw.match(/^@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.+)$/);
    if (!tagsMatch) return;
    
    const rawTags = tagsMatch[1];
    const username = tagsMatch[2];
    const message = tagsMatch[3];
    
    const tags = {};
    rawTags.split(';').forEach(kv => {
        const eqIdx = kv.indexOf('=');
        if (eqIdx !== -1) {
            tags[kv.substring(0, eqIdx)] = kv.substring(eqIdx + 1);
        }
    });
    
    const isBot = isBotUser(username) || isBotUser(tags['display-name']);

    const userLower = (username || '').toLowerCase();
    const displayLower = (tags['display-name'] || '').toLowerCase();

    // Check all possible Twitch tags/values for first-time chatters (including reply messages)
    const fmVal = String(tags['first-msg'] || tags['first_msg'] || '').trim().toLowerCase();
    const msgIdVal = String(tags['msg-id'] || '').trim().toLowerCase();

    let isFirstMsg = fmVal === '1' || fmVal === 'true'
        || msgIdVal === 'first-msg' || msgIdVal === 'first_msg'
        || msgIdVal === 'user_intro';

    // If this user had a pending introduction ritual notice, consume it for this message only
    if (!isFirstMsg) {
        const now = Date.now();
        if (pendingFirstChatters.has(userLower) && pendingFirstChatters.get(userLower) > now) {
            isFirstMsg = true;
            pendingFirstChatters.delete(userLower);
        } else if (pendingFirstChatters.has(displayLower) && pendingFirstChatters.get(displayLower) > now) {
            isFirstMsg = true;
            pendingFirstChatters.delete(displayLower);
        }
    }

    // Parse threaded reply parent information if available
    let replyParent = null;
    if (tags['reply-parent-msg-id']) {
        let parentBody = (tags['reply-parent-msg-body'] || '')
            .replace(/\\s/g, ' ')
            .replace(/\\:/g, ':')
            .replace(/\\;/g, ';')
            .replace(/\\\\/g, '\\')
            .replace(/\\r/g, '')
            .replace(/\\n/g, ' ')
            .trim();

        replyParent = {
            id: tags['reply-parent-msg-id'],
            displayName: tags['reply-parent-display-name'] || tags['reply-parent-user-login'] || 'User',
            userLogin: tags['reply-parent-user-login'] || '',
            body: parentBody
        };
    }

    let gifUrl = null;
    if (tags['gifs']) {
        const parts = tags['gifs'].split('|');
        if (parts.length >= 3 && parts[2].startsWith('http')) {
            gifUrl = parts.slice(2).join('|');
        }
    }

    // Support Events: Bits and in-chat Sub notices
    let isSubEvent = false;
    let subType = null;
    let subTag = null;

    if (!isBot && tags['bits']) {
        const bitsVal = parseInt(tags['bits'], 10);
        if (!isNaN(bitsVal) && bitsVal > 0) {
            isSubEvent = true;
            subType = 'bits';
            subTag = `💎 ${bitsVal.toLocaleString()} Bits`;
        }
    }

    const msgId = tags['msg-id'] || '';
    if (!isBot) {
        if (msgId === 'resub' || msgId === 'sub') {
            isSubEvent = true;
            subType = 'sub';
            subTag = msgId === 'resub' ? '⭐ Resub' : '⭐ Sub';
        } else if (msgId === 'subgift' || msgId === 'anonsubgift') {
            isSubEvent = true;
            subType = 'giftsub';
            subTag = '🎁 Gift Sub';
        }
    }

    addMessage({
        platform: 'twitch',
        username: tags['display-name'] || username,
        color: tags['color'] || '#9146ff',
        message: message,
        badges: tags['badges'] || '',
        rawEmotes: tags['emotes'] || '',
        firstMsg: !isBot && isFirstMsg,
        replyParent: replyParent,
        gifUrl: gifUrl,
        subEvent: isSubEvent,
        subType: subType,
        subTag: subTag,
        timestamp: Date.now()
    });
}

function parseTwitchUsernotice(raw) {
    const tagsMatch = raw.match(/^@([^ ]+) [^ ]+ USERNOTICE #[^ ]+(?:\s*:(.*))?$/);
    if (!tagsMatch) return;
    
    const rawTags = tagsMatch[1];
    const customMsg = tagsMatch[2] ? tagsMatch[2].trim() : '';
    
    const tags = {};
    rawTags.split(';').forEach(kv => {
        const eqIdx = kv.indexOf('=');
        if (eqIdx !== -1) {
            tags[kv.substring(0, eqIdx)] = kv.substring(eqIdx + 1);
        }
    });

    const msgId = String(tags['msg-id'] || '').trim().toLowerCase();
    const ritualName = String(tags['msg-param-ritual-name'] || '').trim().toLowerCase();
    const category = String(tags['msg-param-category'] || '').trim().toLowerCase();

    let sysMsg = (tags['system-msg'] || '')
        .replace(/\\s/g, ' ')
        .replace(/\\:/g, ':')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\')
        .replace(/\\r/g, '')
        .replace(/\\n/g, ' ')
        .replace(/\\'/g, "'");

    const username = tags['display-name'] || tags['login'] || 'TwitchUser';
    if (isBotUser(username) || isBotUser(tags['login']) || isBotUser(tags['display-name'])) {
        return; // Exclude bots from subscription and ritual events
    }
    const color = tags['color'] || '#9146ff';

    // 1. First-Time Chatter Ritual / Introduction
    const isRitualFirstChatter = (msgId === 'ritual' && ritualName === 'new_chatter')
        || msgId === 'user_intro'
        || msgId === 'first-msg'
        || msgId === 'first_msg'
        || ritualName === 'new_chatter';

    if (isRitualFirstChatter) {
        if (username) pendingFirstChatters.set(username.toLowerCase(), Date.now() + 60000);
        if (tags['login']) pendingFirstChatters.set(tags['login'].toLowerCase(), Date.now() + 60000);

        addMessage({
            platform: 'twitch',
            username: username,
            color: color,
            message: customMsg || sysMsg || `${username} is chatting for the first time!`,
            badges: tags['badges'] || '',
            rawEmotes: tags['emotes'] || '',
            firstMsg: true,
            subEvent: false,
            timestamp: Date.now()
        });
        return;
    }

    // 2. Stream Streaks / Watch Streaks (viewermilestone):
    // Must NOT have sub badge and must NOT be highlighted as sub
    if (msgId === 'viewermilestone' || category === 'watch-streak') {
        const streakText = customMsg || sysMsg || `${username} shared a watch streak!`;
        const streakSystemNotice = customMsg && sysMsg ? sysMsg : '';
        addMessage({
            platform: 'twitch',
            username: username,
            color: color,
            message: streakText,
            systemMsg: streakSystemNotice,
            badges: tags['badges'] || '',
            rawEmotes: tags['emotes'] || '',
            firstMsg: false,
            subEvent: false,
            subType: null,
            subTag: null,
            timestamp: Date.now()
        });
        return;
    }

    // 3. Raids: Clean notification without sub badge
    if (msgId === 'raid' || msgId === 'unraid') {
        const raidCount = tags['msg-param-viewerCount'] || tags['msg-param-viewercount'] || '';
        const raidText = sysMsg || (raidCount ? `${username} raided with ${raidCount} viewers!` : `${username} raided the channel!`);
        addMessage({
            platform: 'twitch',
            username: username,
            color: color,
            message: raidText,
            badges: tags['badges'] || '',
            rawEmotes: tags['emotes'] || '',
            firstMsg: false,
            subEvent: false,
            timestamp: Date.now()
        });
        return;
    }

    // 4. Subscriptions, Resubs, Gift Subs & Bits Badges ONLY
    let isSubEvent = false;
    let subType = null;
    let tagLabel = null;
    const isPrime = tags['msg-param-sub-plan'] === 'Prime';

    if (msgId === 'sub') {
        isSubEvent = true;
        subType = 'sub';
        tagLabel = isPrime ? '👑 Prime Sub' : '⭐ Sub';
    } else if (msgId === 'resub') {
        isSubEvent = true;
        subType = 'resub';
        const months = tags['msg-param-cumulative-months'] || tags['msg-param-months'] || '';
        if (isPrime) {
            tagLabel = months ? `👑 Prime Resub (${months} mo)` : '👑 Prime Resub';
        } else {
            tagLabel = months ? `⭐ Resub (${months} mo)` : '⭐ Resub';
        }
    } else if (msgId === 'subgift' || msgId === 'anonsubgift') {
        isSubEvent = true;
        subType = 'giftsub';
        const recipient = tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'];
        tagLabel = recipient ? `🎁 Gift Sub ➔ ${recipient}` : '🎁 Gift Sub';
    } else if (msgId === 'submysterygift' || msgId === 'anonmysterysubgift') {
        isSubEvent = true;
        subType = 'giftsub';
        const count = tags['msg-param-mass-gift-count'] || tags['msg-param-sender-count'] || '';
        tagLabel = count ? `🎁 ${count} Gift Subs` : '🎁 Gift Subs';
    } else if (msgId === 'primecommunitygift') {
        isSubEvent = true;
        subType = 'giftsub';
        tagLabel = '🎁 Prime Gift';
    } else if (msgId === 'bitsbadgetier' || msgId === 'rewardgift') {
        isSubEvent = true;
        subType = 'bits';
        tagLabel = '💎 Bits';
    } else if (msgId === 'giftpaidupgrade') {
        isSubEvent = true;
        subType = 'sub';
        tagLabel = '⭐ Sub Upgrade';
    }

    if (!isSubEvent) {
        // Unknown or general milestone notice: display as standard chat notification, NOT as sub
        addMessage({
            platform: 'twitch',
            username: username,
            color: color,
            message: customMsg || sysMsg || `${username} milestone`,
            systemMsg: customMsg && sysMsg ? sysMsg : '',
            badges: tags['badges'] || '',
            rawEmotes: tags['emotes'] || '',
            firstMsg: false,
            subEvent: false,
            subType: null,
            subTag: null,
            timestamp: Date.now()
        });
        return;
    }

    const displayText = customMsg || sysMsg || `${username} subscribed to the channel!`;
    const systemNotice = customMsg && sysMsg ? sysMsg : '';

    addMessage({
        platform: 'twitch',
        username: username,
        color: color,
        message: displayText,
        systemMsg: systemNotice,
        badges: tags['badges'] || '',
        rawEmotes: tags['emotes'] || '',
        subEvent: true,
        subType: subType,
        subTag: tagLabel,
        timestamp: Date.now()
    });
}

// Kick Centrifugo
let kickWs = null;
let kickPingTimer = null;

async function getKickToken() {
    try {
        const res = await fetch('https://token.kick.cx/api/auth');
        const json = await res.json();
        return json?.data?.token || null;
    } catch (e) {
        return null;
    }
}

async function initKick() {
    const token = await getKickToken();
    if (!token) {
        setTimeout(initKick, 5000);
        return;
    }
    
    try {
        kickWs = new WebSocket('wss://ws-chat.kick.cx/connection/websocket', {
            headers: {
                'Origin': 'https://chat.kick.cx',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        kickWs.onopen = () => {
            kickWs.send(JSON.stringify({
                connect: { token: token, name: 'js' },
                id: 1
            }));
            
            clearInterval(kickPingTimer);
            kickPingTimer = setInterval(() => {
                if (kickWs && kickWs.readyState === WebSocket.OPEN) {
                    kickWs.send(JSON.stringify({}));
                }
            }, 25000);
        };
        
        kickWs.onmessage = (event) => {
            const raw = String(event.data);
            for (const line of raw.split('\n')) {
                if (!line) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.id === 1 && !data.error) {
                        kickWs.send(JSON.stringify({
                            subscribe: { channel: `chatrooms.${STREAMER.kickChatroomId}.v2` },
                            id: 2
                        }));
                    }
                    if (data.push?.pub?.data) {
                        parseKickPush(data.push.pub.data);
                    }
                } catch (e) {}
            }
        };
        
        kickWs.onclose = () => {
            clearInterval(kickPingTimer);
            setTimeout(initKick, 4000);
        };
        kickWs.onerror = () => {};
    } catch (e) {
        setTimeout(initKick, 5000);
    }
}

function parseKickPush(payload) {
    let eventData = payload;
    if (typeof payload === 'string') {
        try { eventData = JSON.parse(payload); } catch (e) { return; }
    }

    const eventName = eventData.event || eventData.type || '';
    let msgObj = eventData.data || eventData;
    if (typeof msgObj === 'string') {
        try { msgObj = JSON.parse(msgObj); } catch (e) {}
    }

    let isSubEvent = false;
    let subType = null;
    let subTag = null;
    let username = 'KickUser';
    let content = '';
    let color = '#00e701';

    // Kick Subscription & Gift Sub Events
    if (eventName.includes('SubscriptionEvent') || eventName === 'subscription') {
        isSubEvent = true;
        subType = 'sub';
        username = msgObj.username || 'KickUser';
        const months = msgObj.months || 1;
        subTag = months > 1 ? `⭐ Resub (${months} mo)` : '⭐ Sub';
        content = `${username} subscribed to the channel! (${months} month${months > 1 ? 's' : ''})`;
    } else if (eventName.includes('GiftedSubscriptions') || eventName.includes('LuckyUsersWhoGotGift') || eventName === 'gifted_subscriptions') {
        isSubEvent = true;
        subType = 'giftsub';
        username = msgObj.gifter_username || msgObj.username || 'Someone';
        const giftCount = msgObj.gifted_usernames?.length || msgObj.count || 1;
        subTag = `🎁 ${giftCount} Gift Sub${giftCount > 1 ? 's' : ''}`;
        content = `${username} gifted ${giftCount} subscription${giftCount > 1 ? 's' : ''} to the channel!`;
    } else {
        const sender = msgObj.sender || msgObj.user || {};
        username = sender.username || 'KickUser';
        content = msgObj.content || msgObj.message || '';
        color = sender.identity?.color || '#00e701';
    }
    
    if (content) {
        if (isBotUser(username)) {
            isSubEvent = false;
            subType = null;
            subTag = null;
        }
        addMessage({
            platform: 'kick',
            username: username,
            color: color,
            message: content,
            subEvent: isSubEvent,
            subType: subType,
            subTag: subTag,
            timestamp: Date.now()
        });
    }
}

// YouTube Poller
let ytContinuation = null;
let ytPollTimer = null;

async function pollYouTubeChat() {
    try {
        if (!ytContinuation) {
            const url = `https://www.youtube.com/live_chat?v=${encodeURIComponent(currentYtVideoId)}`;
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                }
            });
            const html = await res.text();
            const km = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
            if (km) ytApiKey = km[1];
            
            const dm = html.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});<\/script>/s);
            if (dm) {
                const initialData = JSON.parse(dm[1]);
                const actions = initialData?.contents?.liveChatRenderer?.actions || [];
                for (const act of actions) processYtAction(act);
                
                const conts = initialData?.contents?.liveChatRenderer?.continuations || [];
                ytContinuation = conts[0]?.invalidationContinuationData?.continuation 
                              || conts[0]?.timedContinuationData?.continuation || null;
            }
        } else {
            const postUrl = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${ytApiKey}`;
            const body = {
                context: { client: { clientName: 'WEB', clientVersion: '2.20240401.01.00', hl: 'en', gl: 'US' } },
                continuation: ytContinuation
            };
            const res = await fetch(postUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0',
                    'Referer': `https://www.youtube.com/live_chat?v=${currentYtVideoId}`,
                    'Origin': 'https://www.youtube.com'
                },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            const actions = data?.continuationContents?.liveChatContinuation?.actions || [];
            for (const act of actions) processYtAction(act);
            
            const nextConts = data?.continuationContents?.liveChatContinuation?.continuations || [];
            ytContinuation = nextConts[0]?.invalidationContinuationData?.continuation 
                          || nextConts[0]?.timedContinuationData?.continuation || null;
        }
    } catch (e) {}
}

function processYtAction(act) {
    const addAction = act?.addChatItemAction?.item || act?.addLiveChatTickerItemAction?.item;
    if (!addAction) return;

    const textItem = addAction.liveChatTextMessageRenderer;
    const paidItem = addAction.liveChatPaidMessageRenderer;
    const stickerItem = addAction.liveChatPaidStickerRenderer;
    const memberItem = addAction.liveChatMembershipItemRenderer;
    const giftItem = addAction.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;

    const item = textItem || paidItem || stickerItem || memberItem || giftItem;
    if (!item) return;

    let isSubEvent = false;
    let subType = null;
    let subTag = null;

    let author = item?.authorName?.simpleText 
              || item?.header?.liveChatSponsorshipsHeaderRenderer?.authorName?.simpleText 
              || 'YouTubeUser';
    let text = '';

    const runs = item?.message?.runs || item?.headerSubtext?.runs || item?.header?.liveChatSponsorshipsHeaderRenderer?.primaryText?.runs || [];
    for (const run of runs) {
        if (run.emoji && run.emoji.image?.thumbnails?.[0]?.url) {
            const emoteUrl = run.emoji.image.thumbnails[0].url;
            const emoteLabel = run.emoji.shortcuts?.[0] || run.emoji.image.accessibility?.accessibilityData?.label || 'emoji';
            text += `__YTEMOTE__:${encodeURIComponent(emoteUrl)}:${encodeURIComponent(emoteLabel)}__ `;
        } else {
            text += run.text || '';
        }
    }

    if (paidItem) {
        isSubEvent = true;
        subType = 'superchat';
        const amount = paidItem.purchaseAmountText?.simpleText || '';
        subTag = amount ? `💰 Super Chat (${amount})` : '💰 Super Chat';
        text = text ? `[${amount}] ${text}` : `Sent a ${amount} Super Chat!`;
    } else if (stickerItem) {
        isSubEvent = true;
        subType = 'supersticker';
        const amount = stickerItem.purchaseAmountText?.simpleText || '';
        subTag = amount ? `🎨 Super Sticker (${amount})` : '🎨 Super Sticker';
        text = `Sent a Super Sticker! (${amount})`;
    } else if (memberItem) {
        isSubEvent = true;
        subType = 'membership';
        subTag = '⭐ Member';
        const subtext = item.headerSubtext?.simpleText || runs.map(r => r.text || '').join('') || 'Joined as a channel member!';
        text = text ? `${subtext} — ${text}` : subtext;
    } else if (giftItem) {
        isSubEvent = true;
        subType = 'giftsub';
        subTag = '🎁 Gift Member';
        const prim = item.header?.liveChatSponsorshipsHeaderRenderer?.primaryText?.runs?.map(r => r.text || '').join('') || 'Gifted channel memberships!';
        text = prim;
    }

    const avatar = item?.authorPhoto?.thumbnails?.[0]?.url || null;

    if (text) {
        if (isBotUser(author)) {
            isSubEvent = false;
            subType = null;
            subTag = null;
        }
        addMessage({
            id: item.id || null,
            platform: 'youtube',
            username: author,
            color: '#ff4d4d',
            avatar: avatar,
            message: text.trim(),
            subEvent: isSubEvent,
            subType: subType,
            subTag: subTag,
            timestamp: parseInt((item.timestampUsec || (Date.now() * 1000)) / 1000)
        });
    }
}

// ==========================================
// 5. STATIC FILES & HTTP SERVER
// ==========================================
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const PUBLIC_DIR = path.join(__dirname, 'public');

// Cookie & Auth Helpers
function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (!rc) return list;
    rc.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        const key = parts.shift().trim();
        const val = decodeURIComponent(parts.join('=') || '');
        if (key) list[key] = val;
    });
    return list;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 1e6) { // 1MB protection
                req.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            if (!data.trim()) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function getTwitchRedirectUri(req) {
    if (process.env.TWITCH_REDIRECT_URI) {
        return process.env.TWITCH_REDIRECT_URI;
    }
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}/auth/twitch/callback`;
}

async function refreshTwitchUserToken(session) {
    if (!session || !session.refreshToken || !TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return false;
    try {
        const params = new URLSearchParams({
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken
        });
        const res = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const data = await res.json();
        if (data.access_token) {
            session.accessToken = data.access_token;
            if (data.refresh_token) session.refreshToken = data.refresh_token;
            session.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
            return true;
        }
    } catch (e) {
        console.error('[Twitch Auth] Refresh token failed:', e);
    }
    return false;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    
    // API: Health
    if (pathname === '/health' || pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            clientsCount: wsClients.size,
            ytVideoId: currentYtVideoId,
            historyCount: recentMessages.length
        }));
        return;
    }
    
    // API: History
    if (pathname === '/api/history' || pathname === '/history') {
        const history = getFullHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            messages: history,
            ytVideoId: currentYtVideoId
        }));
        return;
    }
    
    // API: YouTube Status
    if (pathname === '/api/youtube') {
        const force = url.searchParams.get('force') === '1';
        const yt = await getYouTubeLiveStatus(force);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(yt));
        return;
    }
    
    // API: Set YouTube Video
    if (pathname === '/api/set_yt' || pathname === '/set_yt') {
        const vid = url.searchParams.get('v');
        if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
            currentYtVideoId = vid;
            ytContinuation = null;
            pollYouTubeChat();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, videoId: currentYtVideoId }));
            return;
        }
    }
    
    // API: 7TV Emotes
    if (pathname === '/api/7tv_emotes') {
        const force = url.searchParams.get('force') === '1';
        const emotes = await get7TvEmotes(force);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(emotes));
        return;
    }
    
    // API: Status All
    if (pathname === '/api/status_all') {
        const [yt, kick, twitch] = await Promise.all([
            getYouTubeLiveStatus(),
            getKickStatus(),
            getTwitchStatus()
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ youtube: yt, kick, twitch }));
        return;
    }

    // Backward compatibility for /api.php requests
    if (pathname === '/api.php') {
        const action = url.searchParams.get('action');
        if (action === 'youtube') {
            const force = url.searchParams.get('force') === '1';
            const yt = await getYouTubeLiveStatus(force);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(yt));
            return;
        }
        if (action === '7tv_emotes') {
            const force = url.searchParams.get('force') === '1';
            const emotes = await get7TvEmotes(force);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(emotes));
            return;
        }
        if (action === 'set_bridge_yt' || action === 'set_yt') {
            const vid = url.searchParams.get('v');
            if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
                currentYtVideoId = vid;
                ytContinuation = null;
                pollYouTubeChat();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, videoId: currentYtVideoId }));
                return;
            }
        }
        if (action === 'bridge_status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ running: true, port: PORT }));
            return;
        }
    }

    // ==========================================
    // TWITCH OAUTH & HELIX CHAT ROUTES
    // ==========================================
    
    // Auth: Initiate Twitch OAuth
    if (pathname === '/auth/twitch') {
        if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h3>Twitch Chat is not configured</h3><p>Please configure <code>TWITCH_CLIENT_ID</code> and <code>TWITCH_CLIENT_SECRET</code> in your Render environment variables.</p><p><a href="/">Back to Chat</a></p>');
            return;
        }
        
        const stateToken = crypto.randomBytes(16).toString('hex');
        oauthStates.set(stateToken, Date.now() + 600000); // 10 min TTL
        
        const redirectUri = getTwitchRedirectUri(req);
        const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('user:write:chat user:read:chat')}&state=${stateToken}&force_verify=true`;
        
        res.writeHead(302, { 'Location': authUrl });
        res.end();
        return;
    }

    // Auth: Twitch OAuth Callback
    if (pathname === '/auth/twitch/callback') {
        if (url.searchParams.get('error')) {
            const err = url.searchParams.get('error_description') || url.searchParams.get('error') || 'Twitch authorization denied';
            res.writeHead(302, { 'Location': '/?auth_error=' + encodeURIComponent(err) });
            res.end();
            return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
            res.writeHead(302, { 'Location': '/?auth_error=Missing+authorization+code' });
            res.end();
            return;
        }

        const redirectUri = getTwitchRedirectUri(req);
        try {
            const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: TWITCH_CLIENT_ID,
                    client_secret: TWITCH_CLIENT_SECRET,
                    code: code,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri
                }).toString()
            });

            const tokenData = await tokenRes.json();
            if (!tokenRes.ok || !tokenData.access_token) {
                const errMsg = tokenData.message || 'Token exchange failed';
                res.writeHead(302, { 'Location': '/?auth_error=' + encodeURIComponent(errMsg) });
                res.end();
                return;
            }

            // Fetch user profile from Helix
            const userRes = await fetch('https://api.twitch.tv/helix/users', {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`,
                    'Client-Id': TWITCH_CLIENT_ID
                }
            });
            const userData = await userRes.json();
            const user = userData.data?.[0];
            if (!user) {
                res.writeHead(302, { 'Location': '/?auth_error=Failed+to+fetch+Twitch+profile' });
                res.end();
                return;
            }

            const sessionId = crypto.randomBytes(32).toString('hex');
            userSessions.set(sessionId, {
                sessionId,
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: Date.now() + ((tokenData.expires_in || 3600) * 1000),
                user: {
                    id: user.id,
                    login: user.login,
                    displayName: user.display_name,
                    avatar: user.profile_image_url
                }
            });

            const isHttps = (req.headers['x-forwarded-proto'] === 'https') || req.socket.encrypted;
            const cookieVal = `twitch_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? '; Secure' : ''}`;
            res.writeHead(302, {
                'Set-Cookie': cookieVal,
                'Location': '/?connected=twitch'
            });
            res.end();
            return;
        } catch (err) {
            console.error('[Twitch OAuth Callback] Error:', err);
            res.writeHead(302, { 'Location': '/?auth_error=Authentication+server+error' });
            res.end();
            return;
        }
    }

    // API: Current Authenticated User & App Config Status
    if (pathname === '/api/user') {
        const isConfigured = Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
        if (!isConfigured) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ configured: false, authenticated: false }));
            return;
        }

        const cookies = parseCookies(req);
        const sessionId = cookies.twitch_session;
        let session = sessionId ? userSessions.get(sessionId) : null;

        if (session && session.user) {
            if (session.expiresAt && session.expiresAt < Date.now() + 60000) {
                await refreshTwitchUserToken(session);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                configured: true,
                authenticated: true,
                user: session.user
            }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            configured: true,
            authenticated: false
        }));
        return;
    }

    // API: Send Message to Twitch Chat (#glorious_e)
    if (pathname === '/api/chat/send') {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
            return;
        }

        const cookies = parseCookies(req);
        const sessionId = cookies.twitch_session;
        let session = sessionId ? userSessions.get(sessionId) : null;

        if (!session || !session.user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'You must connect your Twitch account to send messages.' }));
            return;
        }

        let body;
        try {
            body = await readJsonBody(req);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON request payload.' }));
            return;
        }

        const messageText = (body.message || '').trim();
        if (!messageText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Message cannot be empty.' }));
            return;
        }
        if (messageText.length > 500) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Message cannot exceed 500 characters.' }));
            return;
        }

        if (session.expiresAt && session.expiresAt < Date.now() + 60000) {
            await refreshTwitchUserToken(session);
        }

        try {
            const sendRes = await fetch('https://api.twitch.tv/helix/chat/messages', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.accessToken}`,
                    'Client-Id': TWITCH_CLIENT_ID,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    broadcaster_id: STREAMER.twitchUserId, // '63304572'
                    sender_id: session.user.id,
                    message: messageText
                })
            });

            const sendData = await sendRes.json();

            if (sendRes.ok && sendData.data?.[0]) {
                const msgResult = sendData.data[0];
                if (msgResult.is_sent) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        messageId: msgResult.message_id,
                        user: session.user
                    }));
                    return;
                } else {
                    const reason = msgResult.drop_reason?.message || msgResult.drop_reason?.code || 'Message was dropped by Twitch channel rules.';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: reason }));
                    return;
                }
            }

            const errMsg = sendData.message || (sendData.error ? `${sendData.error}: ${sendData.message || ''}` : 'Failed to send Twitch message.');
            const statusCode = (sendRes.status >= 400 && sendRes.status < 500) ? sendRes.status : 400;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: errMsg }));
            return;
        } catch (err) {
            console.error('[Twitch Chat Send] Error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Network error sending Twitch message.' }));
            return;
        }
    }

    // API & Route: Logout / Disconnect Twitch Account
    if (pathname === '/api/chat/logout' || pathname === '/auth/logout') {
        const cookies = parseCookies(req);
        if (cookies.twitch_session) {
            userSessions.delete(cookies.twitch_session);
        }
        const isHttps = (req.headers['x-forwarded-proto'] === 'https') || req.socket.encrypted;
        const cookieVal = `twitch_session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${isHttps ? '; Secure' : ''}`;
        
        if (req.method === 'POST') {
            res.writeHead(200, {
                'Set-Cookie': cookieVal,
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(302, {
                'Set-Cookie': cookieVal,
                'Location': '/'
            });
            res.end();
        }
        return;
    }
    
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Static File Serving
let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
}

// Dynamically inject current YouTube stream status into index.html
if (safePath === '/index.html') {
    let indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
        indexPath = path.join(__dirname, 'index.html');
    }
    if (fs.existsSync(indexPath)) {
        try {
            let html = fs.readFileSync(indexPath, 'utf8');
            if (currentYtVideoId) {
                html = html.replace(/id="initialYtVideoId"\s+value="[^"]*"/, `id="initialYtVideoId" value="${escapeHtml(currentYtVideoId)}"`);
            }
            if (currentYtTitle) {
                html = html.replace(/id="initialYtTitle"\s+value="[^"]*"/, `id="initialYtTitle" value="${escapeHtml(currentYtTitle)}"`);
            }
            html = html.replace(/id="initialYtIsLive"\s+value="[^"]*"/, `id="initialYtIsLive" value="${currentYtIsLive ? '1' : '0'}"`);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        } catch (errHtml) {
            console.warn('[Server] Error dynamically serving index.html:', errHtml.message);
        }
    }
}

let filePath = path.join(PUBLIC_DIR, safePath);

// If not in public/, fallback to root directory for backwards compatibility
if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, safePath);
}

if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
}

// Fallback 404
res.writeHead(404, { 'Content-Type': 'text/plain' });
res.end('Not Found');
});

// WebSocket Upgrade Handler
server.on('upgrade', (req, socket, head) => {
const key = req.headers['sec-websocket-key'];
if (!key) {
    socket.destroy();
    return;
}

const digest = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
    
socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + digest + '\r\n\r\n'
);

wsClients.add(socket);
console.log(`[WebSocket] Client connected. Total: ${wsClients.size}`);

// Immediately send current YouTube stream status on connect
sendWsFrame(socket, JSON.stringify({
    type: 'yt_update',
    videoId: currentYtVideoId,
    title: currentYtTitle,
    isLive: currentYtIsLive
}));

const history = getFullHistory();
if (history.length > 0) {
    sendWsFrame(socket, JSON.stringify({
        type: 'history',
        messages: history
    }));
}

socket.on('close', () => wsClients.delete(socket));
socket.on('error', () => wsClients.delete(socket));
});

server.listen(PORT, '0.0.0.0', () => {
console.log(`=======================================================`);
console.log(` Glorious_E Multi-Chat Server running on port ${PORT}`);
console.log(` Local URL: http://localhost:${PORT}`);
console.log(`=======================================================`);

// Bootstrap services
initTwitch();
initKick();
getYouTubeLiveStatus(true).then(() => {
    clearInterval(ytPollTimer);
    ytPollTimer = setInterval(pollYouTubeChat, 2200);
    pollYouTubeChat();
});
get7TvEmotes();

// Periodic background auto-check for YouTube live stream (every 90 seconds)
setInterval(async () => {
    try {
        const prevId = currentYtVideoId;
        const prevLive = currentYtIsLive;
        const status = await getYouTubeLiveStatus(true);
        if (status && status.videoId && (status.videoId !== prevId || status.isLive !== prevLive)) {
            console.log(`[YouTube Live] Stream auto-updated: ${status.videoId} (${status.title}) isLive=${status.isLive}`);
            broadcast({
                type: 'yt_update',
                videoId: status.videoId,
                title: status.title,
                isLive: status.isLive
            });
        }
    } catch (e) {
        console.warn('[YouTube Live] Periodic check failed:', e.message);
    }
}, 90000);
});
