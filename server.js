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
    defaultYtVideoId: 'hjuUwbPqkG8'
};

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
        const url = `https://www.youtube.com/${STREAMER.youtubeHandle}/live`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const html = await res.text();
        
        let videoId = null;
        let title = 'we chillin';
        let isLive = false;
        
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
        
        videoId = videoId || currentYtVideoId || STREAMER.defaultYtVideoId;
        currentYtVideoId = videoId;
        currentYtTitle = title;
        currentYtIsLive = isLive;
        
        const result = {
            success: true,
            channel: STREAMER.youtubeHandle,
            videoId: videoId,
            title: title,
            isLive: isLive,
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
        const [k, v] = kv.split('=');
        tags[k] = v;
    });
    
    const isFirstMsg = tags['first-msg'] === '1' || tags['msg-id'] === 'first-msg';

    addMessage({
        platform: 'twitch',
        username: tags['display-name'] || username,
        color: tags['color'] || '#9146ff',
        message: message,
        badges: tags['badges'] || '',
        rawEmotes: tags['emotes'] || '',
        firstMsg: isFirstMsg,
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
        const emotes = await get7TvEmotes();
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
            const emotes = await get7TvEmotes();
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
