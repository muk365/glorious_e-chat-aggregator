<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

require_once __DIR__ . '/functions.php';

$action = isset($_GET['action']) ? $_GET['action'] : 'status_all';
$force = isset($_GET['force']) && $_GET['force'] === '1';

// Router
switch ($action) {
    case '7tv_emotes':
        $data = getCachedData('7tv_emotes_63304572', 86400, function() {
            return get7TvEmotes('63304572');
        }, $force);
        echo json_encode($data);
        break;

    case 'bridge_status':
        $isRunning = ensureBridgeRunning();
        echo json_encode([
            'running' => $isRunning,
            'port' => 8088
        ]);
        break;

    case 'yt_chat':
        $v = isset($_GET['v']) ? trim($_GET['v']) : 'hjuUwbPqkG8';
        $continuation = isset($_GET['continuation']) ? trim($_GET['continuation']) : null;
        $res = fetchYouTubeChatFallback($v, $continuation);
        echo json_encode($res);
        break;

    case 'set_bridge_yt':
        $v = isset($_GET['v']) ? trim($_GET['v']) : '';
        if ($v) {
            @file_get_contents("http://127.0.0.1:8088/set_yt?v=" . urlencode($v));
        }
        echo json_encode(['success' => true, 'videoId' => $v]);
        break;

    case 'youtube':
        $channel = isset($_GET['channel']) ? trim($_GET['channel']) : '@GloriousE';
        $data = getCachedData('youtube_' . $channel, 120, function() use ($channel) {
            return checkYoutubeLive($channel);
        }, $force);
        echo json_encode($data);
        break;

    case 'kick':
        $user = isset($_GET['user']) ? trim($_GET['user']) : 'glorious_e';
        $data = getCachedData('kick_' . $user, 60, function() use ($user) {
            return checkKickLive($user);
        }, $force);
        echo json_encode($data);
        break;

    case 'twitch':
        $user = isset($_GET['user']) ? trim($_GET['user']) : 'glorious_e';
        $data = getCachedData('twitch_' . $user, 60, function() use ($user) {
            return checkTwitchLive($user);
        }, $force);
        echo json_encode($data);
        break;

    case 'parse_yt':
        $rawUrl = isset($_GET['url']) ? trim($_GET['url']) : '';
        $extractedId = null;
        if (preg_match('/^[a-zA-Z0-9_-]{11}$/', $rawUrl)) {
            $extractedId = $rawUrl;
        } elseif (preg_match('/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|live\/|live_chat\?v=))([a-zA-Z0-9_-]{11})/i', $rawUrl, $m)) {
            $extractedId = $m[1];
        }
        echo json_encode([
            'success' => ($extractedId !== null),
            'videoId' => $extractedId,
            'input' => $rawUrl
        ]);
        break;

    case 'status_all':
    default:
        $ytChannel = isset($_GET['yt']) ? trim($_GET['yt']) : '@GloriousE';
        $kickUser = isset($_GET['kick']) ? trim($_GET['kick']) : 'glorious_e';
        $twitchUser = isset($_GET['twitch']) ? trim($_GET['twitch']) : 'glorious_e';

        $yt = getCachedData('youtube_' . $ytChannel, 120, function() use ($ytChannel) {
            return checkYoutubeLive($ytChannel);
        }, $force);

        $kick = getCachedData('kick_' . $kickUser, 60, function() use ($kickUser) {
            return checkKickLive($kickUser);
        }, $force);

        $twitch = getCachedData('twitch_' . $twitchUser, 60, function() use ($twitchUser) {
            return checkTwitchLive($twitchUser);
        }, $force);

        echo json_encode([
            'timestamp' => time(),
            'youtube' => $yt,
            'kick' => $kick,
            'twitch' => $twitch
        ]);
        break;
}

