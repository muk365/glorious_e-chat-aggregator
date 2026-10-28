/**
 * Glorious_E Multi-Chat Unified Bridge
 * Combines Twitch, Kick & YouTube Live Chats into a single WebSocket feed
 */

// Prevent EPIPE crash if stdout/stderr pipe is closed
process.stdout?.on('error', (err) => { if (err.code === 'EPIPE') return; });
process.stderr?.on('error', (err) => { if (err.code === 'EPIPE') return; });

const http = require('http');
const crypto = require('crypto');

const PORT = 8088;
const STREAMER = {
    twitch: 'glorious_e',
    kickChatroomId: 7457099,
    youtubeHandle: '@GloriousE',
    defaultYtVideoId: 'hjuUwbPqkG8'
};

// Global state
let currentYtVideoId = STREAMER.defaultYtVideoId;
let recentMessages = [];
const MAX_HISTORY = 1200;
const MAX_HIGHLIGHT_HISTORY = 500;
const recentHighlights = [];
const clients = new Set();
const pendingFirstChatters = new Map();

function addMessage(msg) {
    if (!msg || !msg.message) return;
    msg.id = msg.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    msg.timestamp = msg.timestamp || Date.now();
    
    recentMessages.push(msg);
    if (recentMessages.length > MAX_HISTORY) {
        recentMessages.shift();
    }

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
    for (const client of clients) {
        try {
            sendWsFrame(client, payload);
        } catch (e) {
            clients.delete(client);
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
// 1. TWITCH IRC CONNECTOR
// ==========================================
let twitchWs = null;
function initTwitch() {
    console.log('[Twitch] Connecting to IRC WebSocket...');
    try {
        twitchWs = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        
        twitchWs.onopen = () => {
            console.log('[Twitch] Connected! Sending handshake...');
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
        
        twitchWs.onclose = () => {
            console.log('[Twitch] Disconnected. Reconnecting in 4s...');
            setTimeout(initTwitch, 4000);
        };
        twitchWs.onerror = (e) => console.log('[Twitch] Error:', e.message || e);
    } catch (e) {
        console.error('[Twitch] Init exception:', e);
        setTimeout(initTwitch, 5000);
    }
}

function parseTwitchPrivmsg(raw) {
    // Format: @badge-info=...;color=#...;display-name=... :user!user@... PRIVMSG #channel :Message
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
    
    const displayName = tags['display-name'] || username;
    const color = tags['color'] || '#9146ff';

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
    
    addMessage({
        platform: 'twitch',
        username: displayName,
        color: color,
        message: message,
        badges: tags['badges'] || '',
        rawEmotes: tags['emotes'] || '',
        firstMsg: isFirstMsg,
        replyParent: replyParent,
        gifUrl: gifUrl,
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

// ==========================================
// 2. KICK CENTRIFUGO CONNECTOR
// ==========================================
let kickWs = null;
let kickPingTimer = null;

async function getKickToken() {
    try {
        const res = await fetch('https://token.kick.cx/api/auth');
        const json = await res.json();
        return json?.data?.token || null;
    } catch (e) {
        console.error('[Kick] Failed to get realtime token:', e.message);
        return null;
    }
}

async function initKick() {
    console.log('[Kick] Fetching auth token...');
    const token = await getKickToken();
    if (!token) {
        setTimeout(initKick, 5000);
        return;
    }
    
    console.log('[Kick] Connecting to Centrifugo WebSocket...');
    try {
        kickWs = new WebSocket('wss://ws-chat.kick.cx/connection/websocket', {
            headers: {
                'Origin': 'https://chat.kick.cx',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        kickWs.onopen = () => {
            console.log('[Kick] Connected! Sending Centrifugo connect...');
            kickWs.send(JSON.stringify({
                connect: { token: token, name: 'js' },
                id: 1
            }));
            
            // Heartbeat
            clearInterval(kickPingTimer);
            kickPingTimer = setInterval(() => {
                if (kickWs && kickWs.readyState === WebSocket.OPEN) {
                    kickWs.send(JSON.stringify({}));
                }
            }, 25000);
        };
        
        kickWs.onmessage = (event) => {
            const raw = String(event.data);
            const lines = raw.split('\n');
            for (const line of lines) {
                if (!line) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.id === 1 && !data.error) {
                        console.log(`[Kick] Authenticated! Subscribing to chatrooms.${STREAMER.kickChatroomId}.v2...`);
                        kickWs.send(JSON.stringify({
                            subscribe: { channel: `chatrooms.${STREAMER.kickChatroomId}.v2` },
                            id: 2
                        }));
                    }
                    
                    // Chat message push
                    if (data.push && data.push.pub && data.push.pub.data) {
                        parseKickPush(data.push.pub.data);
                    }
                } catch (e) {}
            }
        };
        
        kickWs.onclose = () => {
            console.log('[Kick] Disconnected. Reconnecting in 4s...');
            clearInterval(kickPingTimer);
            setTimeout(initKick, 4000);
        };
        kickWs.onerror = (e) => console.log('[Kick] Error:', e.message || e);
    } catch (e) {
        console.error('[Kick] Init exception:', e);
        setTimeout(initKick, 5000);
    }
}

function parseKickPush(payload) {
    let eventData = payload;
    if (typeof payload === 'string') {
        try { eventData = JSON.parse(payload); } catch (e) { return; }
    }
    
    // Check if ChatMessageEvent
    let msgObj = eventData.data || eventData;
    if (typeof msgObj === 'string') {
        try { msgObj = JSON.parse(msgObj); } catch (e) {}
    }
    
    const sender = msgObj.sender || msgObj.user || {};
    const username = sender.username || 'KickUser';
    const content = msgObj.content || msgObj.message || '';
    const color = sender.identity?.color || '#00e701';
    
    if (content) {
        addMessage({
            platform: 'kick',
            username: username,
            color: color,
            message: content,
            timestamp: Date.now()
        });
    }
}

// ==========================================
// 3. YOUTUBE LIVE CHAT POLLER
// ==========================================
let ytContinuation = null;
let ytApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
let ytPollTimer = null;

async function pollYouTubeChat() {
    try {
        if (!ytContinuation) {
            // First load: fetch live_chat HTML
            const url = `https://www.youtube.com/live_chat?v=${encodeURIComponent(currentYtVideoId)}`;
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                }
            });
            const html = await res.text();
            
            const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
            if (keyMatch) ytApiKey = keyMatch[1];
            
            const dataMatch = html.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});<\/script>/s);
            if (dataMatch) {
                const initialData = JSON.parse(dataMatch[1]);
                const actions = initialData?.contents?.liveChatRenderer?.actions || [];
                for (const act of actions) {
                    processYtAction(act);
                }
                const conts = initialData?.contents?.liveChatRenderer?.continuations || [];
                ytContinuation = conts[0]?.invalidationContinuationData?.continuation 
                              || conts[0]?.timedContinuationData?.continuation 
                              || null;
            }
        } else {
            // Subsequent request via get_live_chat
            const postUrl = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${ytApiKey}`;
            const body = {
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20240401.01.00',
                        hl: 'en',
                        gl: 'US'
                    }
                },
                continuation: ytContinuation
            };
            
            const res = await fetch(postUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': `https://www.youtube.com/live_chat?v=${currentYtVideoId}`,
                    'Origin': 'https://www.youtube.com'
                },
                body: JSON.stringify(body)
            });
            
            const data = await res.json();
            const actions = data?.continuationContents?.liveChatContinuation?.actions || [];
            for (const act of actions) {
                processYtAction(act);
            }
            
            const nextConts = data?.continuationContents?.liveChatContinuation?.continuations || [];
            ytContinuation = nextConts[0]?.invalidationContinuationData?.continuation 
                          || nextConts[0]?.timedContinuationData?.continuation 
                          || null;
        }
    } catch (e) {
        // Silently retry on next poll
    }
}

function processYtAction(act) {
    const item = act?.addChatItemAction?.item?.liveChatTextMessageRenderer 
              || act?.addChatItemAction?.item?.liveChatPaidMessageRenderer;
    if (!item) return;
    
    const author = item?.authorName?.simpleText || 'YouTubeUser';
    let text = '';
    for (const run of (item?.message?.runs || [])) {
        if (run.emoji && run.emoji.image?.thumbnails?.[0]?.url) {
            const emoteUrl = run.emoji.image.thumbnails[0].url;
            const emoteLabel = run.emoji.shortcuts?.[0] || run.emoji.image.accessibility?.accessibilityData?.label || 'emoji';
            text += `__YTEMOTE__:${encodeURIComponent(emoteUrl)}:${encodeURIComponent(emoteLabel)}__ `;
        } else {
            text += run.text || '';
        }
    }
    const avatar = item?.authorPhoto?.thumbnails?.[0]?.url || null;
    
    if (text) {
        addMessage({
            id: item.id || null,
            platform: 'youtube',
            username: author,
            color: '#ff4d4d',
            avatar: avatar,
            message: text.trim(),
            timestamp: parseInt((item.timestampUsec || (Date.now() * 1000)) / 1000)
        });
    }
}

function startYouTubePoller() {
    clearInterval(ytPollTimer);
    ytPollTimer = setInterval(pollYouTubeChat, 2200);
    pollYouTubeChat();
}

// ==========================================
// 4. LOCAL HTTP & WEBSOCKET SERVER
// ==========================================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            clientsCount: clients.size,
            ytVideoId: currentYtVideoId,
            historyCount: recentMessages.length
        }));
        return;
    }
    
    if (url.pathname === '/history' || url.pathname === '/api/history') {
        const history = getFullHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            messages: history,
            ytVideoId: currentYtVideoId
        }));
        return;
    }
    
    if (url.pathname === '/set_yt') {
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
    
    res.writeHead(404);
    res.end('Not found');
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
    
    clients.add(socket);
    console.log(`[Server] New browser connected. Total clients: ${clients.size}`);
    
    // Immediately inform browser of current YouTube stream ID
    sendWsFrame(socket, JSON.stringify({
        type: 'yt_update',
        videoId: currentYtVideoId,
        title: 'Live Stream',
        isLive: true
    }));

    // Immediately send history on connect
    const history = getFullHistory();
    if (history.length > 0) {
        sendWsFrame(socket, JSON.stringify({
            type: 'history',
            messages: history
        }));
    }
    
    socket.on('close', () => {
        clients.delete(socket);
        console.log(`[Server] Client disconnected. Remaining: ${clients.size}`);
    });
    
    socket.on('error', () => {
        clients.delete(socket);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`=======================================================`);
    console.log(` Unified Multi-Chat Bridge running on ws://127.0.0.1:${PORT}`);
    console.log(` Aggregating: Twitch (#${STREAMER.twitch}), Kick (ID ${STREAMER.kickChatroomId}), YouTube (${currentYtVideoId})`);
    console.log(`=======================================================`);
    
    initTwitch();
    initKick();
    startYouTubePoller();
});

