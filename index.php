<?php
// Initialize server-side detection & ensure real-time multi-chat bridge is running
require_once __DIR__ . '/functions.php';

// Ensure the local Node.js WebSocket bridge is running in background
ensureBridgeRunning();

$ytData = getCachedData('youtube_@GloriousE', 120, function() {
    return checkYoutubeLive('@GloriousE');
});

$kickData = getCachedData('kick_glorious_e', 60, function() {
    return checkKickLive('glorious_e');
});

$twitchData = getCachedData('twitch_glorious_e', 60, function() {
    return checkTwitchLive('glorious_e');
});

$sevenTvEmotes = getCachedData('7tv_emotes_63304572', 86400, function() {
    return get7TvEmotes('63304572');
});

$preloadedYtId = (!empty($ytData['videoId'])) ? $ytData['videoId'] : 'hjuUwbPqkG8';
$preloadedYtTitle = (!empty($ytData['title'])) ? $ytData['title'] : 'we chillin';
$preloadedYtIsLive = !empty($ytData['isLive']) ? '1' : '0';

$streamerAvatar = $twitchData['avatar'] ?? $kickData['avatar'] ?? 'https://static-cdn.jtvnw.net/jtv_user_pictures/d4d79c6d-e57c-487d-912d-e13e85d1a7bf-profile_image-70x70.png';
$currentGame = $twitchData['category'] ?? $kickData['category'] ?? 'Escape from Tarkov';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Glorious_E - Unified Combined Multi-Chat (Kick, Twitch, YouTube)</title>
    <link rel="icon" type="image/png" href="<?php echo htmlspecialchars($streamerAvatar); ?>">
    <link rel="stylesheet" href="css/style.css">
</head>
<body>

<input type="hidden" id="initialYtVideoId" value="<?php echo htmlspecialchars($preloadedYtId); ?>">
<input type="hidden" id="initialYtTitle" value="<?php echo htmlspecialchars($preloadedYtTitle); ?>">
<input type="hidden" id="initialYtIsLive" value="<?php echo htmlspecialchars($preloadedYtIsLive); ?>">

<div class="app-container" id="appContainer">

    <!-- Floating Exit Fullscreen Button -->
    <button class="exit-theater-btn" id="btnExitTheater" title="Exit Theater Mode (Press F)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
        Exit Fullscreen (F)
    </button>

    <!-- Top App Header -->
    <header class="app-header">
        <div class="header-left">
            <div class="streamer-profile">
                <div class="avatar-wrapper">
                    <img src="<?php echo htmlspecialchars($streamerAvatar); ?>" alt="Glorious_E" class="streamer-avatar">
                    <span class="live-pulse-badge" title="Live Streaming"></span>
                </div>
                <div class="streamer-meta">
                    <div class="streamer-name-row">
                        <span class="streamer-title">Glorious_E</span>
                        <span class="verified-badge" title="Verified Streamer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                        </span>
                    </div>
                    <div class="streamer-subtitle">
                        <span>Combined Live Chat</span>
                        <span class="stream-game"><?php echo htmlspecialchars($currentGame); ?></span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Center: Platform Filter Chips with Message Counters -->
        <div class="header-center">
            <!-- Kick Filter Chip -->
            <button class="filter-chip kick active" id="filterKick" title="Click to toggle Kick messages (Press 1)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#00e701"><path d="M3 2h6v6h4V2h8v8h-6v4h6v8h-8v-6h-4v6H3V2z"/></svg>
                <span>Kick</span>
                <span class="chip-dot"></span>
                <span class="chip-count" id="countKick">0</span>
            </button>

            <!-- Twitch Filter Chip -->
            <button class="filter-chip twitch active" id="filterTwitch" title="Click to toggle Twitch messages (Press 2)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#9146ff"><path d="M2.149 0l-1.612 4.119v16.804h5.331v3.077h3.201l3.198-3.077h4.802l6.932-6.928v-13.995h-21.851zm19.715 13.067l-3.734 3.731h-5.333l-3.2 3.077v-3.077h-3.731v-14.8h16v11.069z"/><path d="M17.884 5.334h-2.133v6.4h2.133v-6.4zm-5.334 0h-2.133v6.4h2.133v-6.4z"/></svg>
                <span>Twitch</span>
                <span class="chip-dot"></span>
                <span class="chip-count" id="countTwitch">0</span>
            </button>

            <!-- YouTube Filter Chip -->
            <button class="filter-chip youtube active" id="filterYoutube" title="Click to toggle YouTube messages (Press 3)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#ff0033"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                <span>YouTube</span>
                <span class="chip-dot"></span>
                <span class="chip-count" id="countYoutube">0</span>
            </button>

            <!-- Streamer Mentions Filter Chip -->
            <button class="filter-chip mentions" id="filterMentions" title="Click to view only @Glorious_E tagged messages (Press 4)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#f59e0b"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                <span>@Mentions</span>
                <span class="chip-dot"></span>
                <span class="chip-count" id="countMentions">0</span>
            </button>

            <!-- Subs, Gift Subs & Bits Filter Chip -->
            <button class="filter-chip subs" id="filterSubs" title="Click to view only Subs, Gift Subs & Bits (Press 5)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#ef4444"><path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6.4-4.8-6.4 4.8 2.4-7.2-6-4.8h7.6z"/></svg>
                <span>Subs &amp; Bits</span>
                <span class="chip-dot"></span>
                <span class="chip-count" id="countSubs">0</span>
            </button>
        </div>

        <!-- Right Controls -->
        <div class="header-right">
            <button class="btn-pill" id="btnToggleVideo" title="Watch live video stream above chat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
                <span>Video Stream</span>
            </button>

            <button class="btn-icon" id="btnTheater" title="Fullscreen Chat / Hide Toolbars (Press F)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
        </div>
    </header>

    <!-- Sub-bar: Status, YouTube Live Manager, Font & Chat Controls -->
    <div class="app-subbar">
        <div class="subbar-left">
            <span class="connection-status-tag" id="connectionBadge">
                <span class="chip-dot" style="background:#10b981;box-shadow:0 0 6px #10b981;"></span>
                Live Multi-Chat Connected
            </span>

            <div class="yt-info-group">
                <span>YouTube:</span>
                <strong class="yt-stream-title" id="ytStreamTitle"><?php echo htmlspecialchars($preloadedYtTitle); ?></strong>
                <span class="yt-id-badge" id="ytIdBadge"><?php echo htmlspecialchars($preloadedYtId); ?></span>
            </div>

            <button class="btn-small accent" id="btnDetectYt" title="Auto-detect today's YouTube live stream ID from glorious_e channel">
                🔄 Auto-Detect Live
            </button>
        </div>

        <div class="subbar-right">
            <!-- Manual YouTube URL Form -->
            <form class="yt-input-form" id="ytUrlForm">
                <input type="text" class="yt-input" id="ytUrlInput" placeholder="Paste YouTube link or ID..." title="Paste https://youtube.com/watch?v=... or 11-char video ID">
                <button type="submit" class="btn-small" title="Apply this stream ID">Apply</button>
            </form>

            <!-- Chat Tools -->
            <div class="chat-tools">
                <button class="font-size-btn" id="btnFontMinus" title="Smaller font size">A-</button>
                <button class="font-size-btn" id="btnFontPlus" title="Larger font size">A+</button>
                <button class="btn-small" id="btnToggleScroll" title="Toggle Auto-Scroll">Scroll</button>
                <button class="btn-small" id="btnClearChat" title="Clear current messages (Press X or Delete)">Clear</button>
            </div>
        </div>
    </div>

    <!-- Optional Collapsible Video Stream Drawer -->
    <div class="video-drawer" id="videoDrawer">
        <div class="video-drawer-header">
            <div class="player-switcher">
                <span style="color:var(--text-muted);margin-right:4px;">Stream Feed:</span>
                <button class="player-tab-btn active" data-player="twitch">Twitch Stream</button>
                <button class="player-tab-btn" data-player="kick">Kick Stream</button>
                <button class="player-tab-btn" data-player="youtube">YouTube Stream</button>
            </div>
            <button class="btn-small" onclick="document.getElementById('btnToggleVideo').click()">✕ Close Player</button>
        </div>
        <div class="video-frame-container">
            <iframe id="videoFrame" src="" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture"></iframe>
        </div>
    </div>

    <!-- MAIN UNIFIED COMBINED CHAT AREA -->
    <main class="chat-main-container">

        <div class="chat-scroll-area" id="chatScrollArea">
            <!-- Welcome Info Card -->
            <div class="chat-welcome-banner">
                <div>
                    <div class="welcome-title">Unified Multi-Chat Stream for Glorious_E</div>
                    <div class="welcome-desc">
                        Messages from Kick, Twitch, and YouTube are combined in real-time below with platform badges.
                    </div>
                </div>
                <div class="welcome-platforms">
                    <span class="welcome-pill kick">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="#00e701"><path d="M3 2h6v6h4V2h8v8h-6v4h6v8h-8v-6h-4v6H3V2z"/></svg> Kick
                    </span>
                    <span class="welcome-pill twitch">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="#9146ff"><path d="M2.149 0l-1.612 4.119v16.804h5.331v3.077h3.201l3.198-3.077h4.802l6.932-6.928v-13.995h-21.851zm19.715 13.067l-3.734 3.731h-5.333l-3.2 3.077v-3.077h-3.731v-14.8h16v11.069z"/><path d="M17.884 5.334h-2.133v6.4h2.133v-6.4zm-5.334 0h-2.133v6.4h2.133v-6.4z"/></svg> Twitch
                    </span>
                    <span class="welcome-pill youtube">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="#ff0033"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg> YouTube
                    </span>
                </div>
            </div>

            <!-- The Unified Feed of Messages -->
            <div id="chatFeed"></div>
        </div>

        <!-- Sticky Floating Button when Scrolled Up -->
        <button class="jump-to-bottom-btn" id="jumpToBottomBtn">
            <span>↓ New Messages</span>
            <span class="jump-unread-badge" id="jumpUnreadBadge">0</span>
        </button>

        <!-- Chat Input Bar for Twitch Chatting -->
        <div class="chat-input-bar" id="chatInputBar">
            <!-- State 1: Keys not set in Render -->
            <div class="chat-input-unconfigured" id="chatInputUnconfigured" style="display:none;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="#9146ff"><path d="M2.149 0l-1.612 4.119v16.804h5.331v3.077h3.201l3.198-3.077h4.802l6.932-6.928v-13.995h-21.851zm19.715 13.067l-3.734 3.731h-5.333l-3.2 3.077v-3.077h-3.731v-14.8h16v11.069z"/><path d="M17.884 5.334h-2.133v6.4h2.133v-6.4zm-5.334 0h-2.133v6.4h2.133v-6.4z"/></svg>
                <span>Twitch Chat: Add <code>TWITCH_CLIENT_ID</code> &amp; <code>TWITCH_CLIENT_SECRET</code> to enable sending messages.</span>
            </div>

            <!-- State 2: Configured, but user not logged in -->
            <div class="chat-input-login-prompt" id="chatInputLoginPrompt" style="display:none;">
                <div class="prompt-text-group">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="#9146ff"><path d="M2.149 0l-1.612 4.119v16.804h5.331v3.077h3.201l3.198-3.077h4.802l6.932-6.928v-13.995h-21.851zm19.715 13.067l-3.734 3.731h-5.333l-3.2 3.077v-3.077h-3.731v-14.8h16v11.069z"/><path d="M17.884 5.334h-2.133v6.4h2.133v-6.4zm-5.334 0h-2.133v6.4h2.133v-6.4z"/></svg>
                    <span>Connect your Twitch account to chat directly in <strong>#glorious_e</strong></span>
                </div>
                <a href="/auth/twitch" class="btn-twitch-login" title="Authorize with Twitch to chat directly from this window">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2.149 0l-1.612 4.119v16.804h5.331v3.077h3.201l3.198-3.077h4.802l6.932-6.928v-13.995h-21.851zm19.715 13.067l-3.734 3.731h-5.333l-3.2 3.077v-3.077h-3.731v-14.8h16v11.069z"/><path d="M17.884 5.334h-2.133v6.4h2.133v-6.4zm-5.334 0h-2.133v6.4h2.133v-6.4z"/></svg>
                    <span>Connect Twitch to Chat</span>
                </a>
            </div>

            <!-- State 3: Authenticated -->
            <form class="chat-message-form" id="chatMessageForm" style="display:none;">
                <div class="user-chat-badge" id="userChatBadge" title="Connected Twitch Account">
                    <img src="" alt="" class="user-chat-avatar" id="userChatAvatar">
                    <span class="user-chat-name" id="userChatName"></span>
                    <button type="button" class="btn-chat-logout" id="btnChatLogout" title="Disconnect Twitch Account">✕</button>
                </div>
                <div class="chat-input-wrapper">
                    <input type="text" class="chat-input-field" id="chatInputField" placeholder="Send a message to Glorious_E's Twitch chat..." maxlength="500" autocomplete="off">
                </div>
                <button type="submit" class="btn-chat-send" id="btnChatSend" title="Send message to Twitch (Enter)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    <span>Send</span>
                </button>
            </form>
        </div>

    </main>

    <!-- Bottom Footer -->
    <footer class="app-footer">
        <div class="footer-left">
            <span>Aggregating chats for <strong>Glorious_E</strong></span>
            <span>•</span>
            <a href="https://kick.com/glorious_e" target="_blank" rel="noopener noreferrer" class="footer-link">kick.com/glorious_e</a>
            <span>•</span>
            <a href="https://www.twitch.tv/glorious_e" target="_blank" rel="noopener noreferrer" class="footer-link">twitch.tv/glorious_e</a>
            <span>•</span>
            <a href="https://www.youtube.com/@GloriousE" target="_blank" rel="noopener noreferrer" class="footer-link">youtube.com/@GloriousE</a>
        </div>

        <div class="footer-right">
            <span>Shortcuts:</span>
            <span><kbd class="kbd-badge">F</kbd> Fullscreen</span>
            <span><kbd class="kbd-badge">X</kbd> Clear</span>
            <span><kbd class="kbd-badge">1</kbd> <kbd class="kbd-badge">2</kbd> <kbd class="kbd-badge">3</kbd> <kbd class="kbd-badge">4</kbd> <kbd class="kbd-badge">5</kbd> Filters</span>
        </div>
    </footer>

</div>

<div class="toast-container" id="toastContainer"></div>

<script>
    window.SEVEN_TV_EMOTES = <?php echo json_encode($sevenTvEmotes ?: new stdClass(), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT); ?>;
</script>
<script src="js/app.js"></script>
</body>
</html>
