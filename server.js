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
const MAX_HISTORY = 70;
const wsClients = new Set();

// In-memory caches with TTL
const cache = {
    youtube: { data: null, expires: 0 },
    emotes7tv: { data: null, expires: 0 },
    kick: { data: null, expires: 0 },
    twitch: { data: null, expires: 0 }
};

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
    
    broadcast(msg);
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

        // Method 1: Check https://www.youtube.com/@GloriousE/live with consent bypass
        try {
            const url = `https://www.youtube.com/${STREAMER.youtubeHandle}/live?ucbcb=1`;
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cookie': 'SOCS=CAESEwgDEgk2OTQ0MjAyNjEaAmVuIAEaBgiA_LyaBg; CONSENT=PENDING+999; YES=1'
                },
                redirect: 'follow'
            });
            const html = await res.text();
            
            // Canonical link in <head>
            const canonMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
            if (canonMatch) videoId = canonMatch[1];
            
            // VideoDetails
            const detailsMatch = html.match(/"videoDetails":\{([^}]+)\}/);
            if (detailsMatch) {
                const block = detailsMatch[1];
                if (!videoId) {
                    const vm = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                    if (vm) videoId = vm[1];
                }
                const tm = block.match(/"title":"(.*?)"/);
                if (tm) title = tm[1];
                const lm = block.match(/"isLive":(true|false)/i);
                if (lm) isLive = lm[1] === 'true';
            }
            
            if (html.includes('"isLiveNow":true') || html.includes('"isLiveContent":true')) {
                isLive = true;
            }
        } catch (errLive) {
            console.warn('[YouTube Live] Method 1 failed:', errLive.message);
        }

        // Method 2: If videoId not found or canonical points to channel, check the official XML feed
        if (!videoId && STREAMER.youtubeChannelId) {
            try {
                const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${STREAMER.youtubeChannelId}`;
                const feedRes = await fetch(feedUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const feedText = await feedRes.text();
                const feedVidMatch = feedText.match(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/);
                if (feedVidMatch) {
                    videoId = feedVidMatch[1];
                    const feedTitleMatch = feedText.match(/<entry>[\s\S]*?<title>(.*?)<\/title>/);
                    if (feedTitleMatch) title = feedTitleMatch[1];
                    isLive = true;
                }
            } catch (errFeed) {
                console.warn('[YouTube Live] Method 2 (XML feed) failed:', errFeed.message);
            }
        }

        if (videoId) {
            const changed = (videoId !== currentYtVideoId);
            currentYtVideoId = videoId;
            currentYtTitle = title;
            currentYtIsLive = isLive;
            if (changed) {
                ytContinuation = null;
                pollYouTubeChat();
            }
        } else {
            videoId = currentYtVideoId || STREAMER.defaultYtVideoId;
        }

        const result = {
            success: true,
            channel: STREAMER.youtubeHandle,
            videoId: videoId,
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
            videoId: currentYtVideoId,
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
    
    const isFirstMsg = tags['first-msg'] === '1' || tags['msg-id'] === 'first-msg';

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

    const isBot = isBotUser(username) || isBotUser(tags['display-name']);

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

    const msgId = tags['msg-id'] || 'sub';
    let sysMsg = (tags['system-msg'] || '')
        .replace(/\\s/g, ' ')
        .replace(/\\:/g, ':')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\')
        .replace(/\\'/g, "'");

    const username = tags['display-name'] || tags['login'] || 'TwitchUser';
    if (isBotUser(username) || isBotUser(tags['login']) || isBotUser(tags['display-name'])) {
        return; // Exclude bots from subscription events
    }
    const color = tags['color'] || '#9146ff';

    const isPrime = tags['msg-param-sub-plan'] === 'Prime';
    let tagLabel = isPrime ? '👑 Prime Sub' : '⭐ Sub';
    let subType = 'sub';

    if (msgId === 'resub') {
        subType = 'resub';
        const months = tags['msg-param-cumulative-months'] || tags['msg-param-months'] || '';
        if (isPrime) {
            tagLabel = months ? `👑 Prime Resub (${months} mo)` : '👑 Prime Resub';
        } else {
            tagLabel = months ? `⭐ Resub (${months} mo)` : '⭐ Resub';
        }
    } else if (msgId === 'subgift' || msgId === 'anonsubgift') {
        subType = 'giftsub';
        const recipient = tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'];
        tagLabel = recipient ? `🎁 Gift Sub ➔ ${recipient}` : '🎁 Gift Sub';
    } else if (msgId === 'submysterygift' || msgId === 'anonmysterysubgift') {
        subType = 'giftsub';
        const count = tags['msg-param-mass-gift-count'] || tags['msg-param-sender-count'] || '';
        tagLabel = count ? `🎁 ${count} Gift Subs` : '🎁 Gift Subs';
    } else if (msgId === 'primecommunitygift') {
        subType = 'giftsub';
        tagLabel = '🎁 Prime Gift';
    } else if (msgId === 'bitsbadgetier' || msgId === 'rewardgift') {
        subType = 'bits';
        tagLabel = '💎 Bits';
    } else if (msgId === 'giftpaidupgrade') {
        subType = 'sub';
        tagLabel = '⭐ Sub Upgrade';
    }

    let displayText = customMsg;
    if (!displayText) {
        displayText = sysMsg || `${username} subscribed to the channel!`;
    } else if (sysMsg) {
        displayText = `[${sysMsg}] ${customMsg}`;
    }

    addMessage({
        platform: 'twitch',
        username: username,
        color: color,
        message: displayText,
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
let ytApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            messages: recentMessages,
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
    
    // Static File Serving
    let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') {
        safePath = '/index.html';
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
    
    if (recentMessages.length > 0) {
        sendWsFrame(socket, JSON.stringify({
            type: 'history',
            messages: recentMessages
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
    getYouTubeLiveStatus().then(() => {
        clearInterval(ytPollTimer);
        ytPollTimer = setInterval(pollYouTubeChat, 2200);
        pollYouTubeChat();
    });
    get7TvEmotes();
});
