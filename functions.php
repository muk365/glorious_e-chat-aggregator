<?php
/**
 * Shared API & Stream Helper Functions for Glorious_E
 */

$cacheDir = __DIR__ . '/cache';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0777, true);
}

function getCachedData($cacheKey, $ttlSeconds, $fetchCallback, $force = false) {
    global $cacheDir;
    $cacheFile = $cacheDir . '/' . md5($cacheKey) . '.json';
    
    if (!$force && file_exists($cacheFile)) {
        $mtime = filemtime($cacheFile);
        if (time() - $mtime < $ttlSeconds) {
            $data = json_decode(file_get_contents($cacheFile), true);
            if ($data !== null) {
                $data['from_cache'] = true;
                $data['cache_age'] = time() - $mtime;
                return $data;
            }
        }
    }
    
    $data = $fetchCallback();
    if ($data !== null && (!isset($data['success']) || $data['success'] !== false)) {
        @file_put_contents($cacheFile, json_encode($data, JSON_PRETTY_PRINT));
    }
    $data['from_cache'] = false;
    return $data;
}

function checkYoutubeLive($handle = '@GloriousE') {
    $cleanHandle = ltrim($handle, '/');
    if (!str_starts_with($cleanHandle, '@') && !str_starts_with($cleanHandle, 'channel/') && !str_starts_with($cleanHandle, 'c/')) {
        $cleanHandle = '@' . $cleanHandle;
    }
    
    $url = "https://www.youtube.com/" . $cleanHandle . "/live";
    $ctx = stream_context_create([
        "http" => [
            "method" => "GET",
            "header" => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n" .
                        "Accept-Language: en-US,en;q=0.9\r\n",
            "follow_location" => 1,
            "timeout" => 7
        ]
    ]);
    
    $html = @file_get_contents($url, false, $ctx);
    if (!$html) {
        return [
            'success' => false,
            'isLive' => false,
            'videoId' => null,
            'title' => null,
            'error' => 'Could not connect to YouTube'
        ];
    }
    
    $videoId = null;
    $title = null;
    $isLive = false;
    
    // 1. Check canonical link in <head> (Highest accuracy for the target stream)
    if (preg_match('/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/', $html, $m)) {
        $videoId = $m[1];
    }

    // 2. Extract videoDetails block for the primary video
    if (preg_match('/"videoDetails":\{([^}]+)\}/', $html, $detailsMatch)) {
        $detailsBlock = $detailsMatch[1];
        if (!$videoId && preg_match('/"videoId":"([a-zA-Z0-9_-]{11})"/', $detailsBlock, $vm)) {
            $videoId = $vm[1];
        }
        if (preg_match('/"title":"(.*?)"/', $detailsBlock, $tm)) {
            $title = $tm[1];
        }
        if (preg_match('/"isLive":(true|false)/i', $detailsBlock, $lm)) {
            $isLive = ($lm[1] === 'true');
        } elseif (preg_match('/"isLiveContent":true/i', $html)) {
            $isLive = true;
        }
    }

    // 3. Fallbacks if needed
    if (!$title) {
        if (preg_match('/"title":\{"runs":\[\{"text":"(.*?)"\}\]/', $html, $m)) {
            $title = $m[1];
        } elseif (preg_match('/<title>(.*?) - YouTube<\/title>/', $html, $m)) {
            $title = $m[1];
        }
    }

    if (preg_match('/"isLiveNow":true/i', $html)) {
        $isLive = true;
    }
    
    return [
        'success' => true,
        'channel' => $handle,
        'videoId' => $videoId,
        'title' => html_entity_decode($title ?? 'YouTube Live', ENT_QUOTES | ENT_HTML5, 'UTF-8'),
        'isLive' => (bool)$isLive,
        'watchUrl' => $videoId ? "https://www.youtube.com/watch?v={$videoId}" : null,
        'chatEmbedUrl' => $videoId ? "https://www.youtube.com/live_chat?v={$videoId}" : null,
        'checkedAt' => date('c')
    ];
}

function checkKickLive($username = 'glorious_e') {
    $url = "https://kick.com/api/v2/channels/" . urlencode($username);
    $ctx = stream_context_create([
        "http" => [
            "method" => "GET",
            "header" => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n" .
                        "Accept: application/json\r\n",
            "timeout" => 5
        ]
    ]);
    
    $res = @file_get_contents($url, false, $ctx);
    if (!$res) {
        return [
            'success' => false,
            'isLive' => false,
            'username' => $username,
            'error' => 'Could not fetch Kick API'
        ];
    }
    
    $json = json_decode($res, true);
    if (!$json) {
        return [
            'success' => false,
            'isLive' => false,
            'username' => $username,
            'error' => 'Invalid JSON from Kick'
        ];
    }
    
    $livestream = $json['livestream'] ?? null;
    $isLive = ($livestream !== null && !empty($livestream['is_live']));
    $category = null;
    if ($livestream && !empty($livestream['categories'][0]['name'])) {
        $category = $livestream['categories'][0]['name'];
    }
    
    return [
        'success' => true,
        'username' => $username,
        'displayName' => $json['user']['username'] ?? $username,
        'isLive' => (bool)$isLive,
        'title' => $livestream['session_title'] ?? null,
        'viewers' => $livestream['viewer_count'] ?? 0,
        'category' => $category,
        'avatar' => $json['user']['profile_pic'] ?? null,
        'checkedAt' => date('c')
    ];
}

function checkTwitchLive($username = 'glorious_e') {
    $query = json_encode([
        "query" => 'query { user(login: "' . addslashes($username) . '") { id displayName profileImageURL(width: 70) stream { id title viewersCount game { name } } } }'
    ]);
    
    $ctx = stream_context_create([
        "http" => [
            "method" => "POST",
            "header" => "Client-ID: kimne78kx3ncx6brgo4mv6wki5h1ko\r\nContent-Type: application/json\r\n",
            "content" => $query,
            "timeout" => 5
        ]
    ]);
    
    $res = @file_get_contents("https://gql.twitch.tv/gql", false, $ctx);
    if (!$res) {
        return [
            'success' => false,
            'isLive' => false,
            'username' => $username,
            'error' => 'Could not connect to Twitch GQL'
        ];
    }
    
    $json = json_decode($res, true);
    $user = $json['data']['user'] ?? null;
    $stream = $user['stream'] ?? null;
    
    return [
        'success' => true,
        'username' => $username,
        'displayName' => $user['displayName'] ?? $username,
        'isLive' => ($stream !== null),
        'title' => $stream['title'] ?? null,
        'viewers' => $stream['viewersCount'] ?? 0,
        'category' => $stream['game']['name'] ?? null,
        'avatar' => $user['profileImageURL'] ?? null,
        'checkedAt' => date('c')
    ];
}

function get7TvEmotes($twitchUserId = '63304572') {
    $emotes = [];
    
    // 1. Fetch channel 7TV emotes
    $ctx = stream_context_create([
        "http" => [
            "method" => "GET",
            "header" => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n",
            "timeout" => 6
        ]
    ]);
    
    $channelJson = @file_get_contents("https://7tv.io/v3/users/twitch/" . urlencode($twitchUserId), false, $ctx);
    if ($channelJson) {
        $data = json_decode($channelJson, true);
        foreach ($data['emote_set']['emotes'] ?? [] as $e) {
            $name = $e['name'] ?? null;
            $hostUrl = $e['data']['host']['url'] ?? null;
            if ($name && $hostUrl) {
                $emotes[$name] = "https:" . $hostUrl . "/2x.webp";
            }
        }
    }
    
    // 2. Fetch global 7TV emotes
    $globalJson = @file_get_contents("https://7tv.io/v3/emote-sets/global", false, $ctx);
    if ($globalJson) {
        $data = json_decode($globalJson, true);
        foreach ($data['emotes'] ?? [] as $e) {
            $name = $e['name'] ?? null;
            $hostUrl = $e['data']['host']['url'] ?? null;
            if ($name && $hostUrl && !isset($emotes[$name])) {
                $emotes[$name] = "https:" . $hostUrl . "/2x.webp";
            }
        }
    }
    
    return $emotes;
}

function ensureBridgeRunning() {
    $fp = @fsockopen('127.0.0.1', 8088, $errno, $errstr, 0.3);
    if ($fp) {
        fclose($fp);
        return true;
    }
    
    $script = __DIR__ . '/bridge.js';
    if (file_exists($script)) {
        if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
            @pclose(@popen("cmd /c start \"\" /B node \"" . $script . "\" > nul 2>&1", "r"));
        } else {
            @exec("node \"" . $script . "\" > /dev/null 2>&1 &");
        }
        usleep(300000); // 300ms
        $check = @fsockopen('127.0.0.1', 8088, $errno, $errstr, 0.5);
        if ($check) {
            fclose($check);
            return true;
        }
    }
    return false;
}

function fetchYouTubeChatFallback($videoId, $continuation = null) {
    if (!$continuation) {
        $url = "https://www.youtube.com/live_chat?v=" . urlencode($videoId);
        $ctx = stream_context_create([
            "http" => [
                "method" => "GET",
                "header" => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n"
            ]
        ]);
        $html = @file_get_contents($url, false, $ctx);
        if (!$html) return ["success" => false, "messages" => [], "continuation" => null];
        
        $messages = [];
        $nextContinuation = null;
        $apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        if (preg_match("/\"INNERTUBE_API_KEY\":\"([^\"]+)\"/", $html, $km)) {
            $apiKey = $km[1];
        }
        
        if (preg_match("/window\[\"ytInitialData\"\]\s*=\s*(\{.*?\});<\/script>/s", $html, $m)) {
            $data = json_decode($m[1], true);
            $actions = $data["contents"]["liveChatRenderer"]["actions"] ?? [];
            foreach ($actions as $act) {
                $item = $act["addChatItemAction"]["item"]["liveChatTextMessageRenderer"] 
                     ?? $act["addChatItemAction"]["item"]["liveChatPaidMessageRenderer"] 
                     ?? null;
                if ($item) {
                    $author = $item["authorName"]["simpleText"] ?? "User";
                    $msg = "";
                    foreach ($item["message"]["runs"] ?? [] as $run) {
                        $msg .= $run["text"] ?? "";
                    }
                    $messages[] = [
                        "id" => $item["id"] ?? uniqid("yt_"),
                        "platform" => "youtube",
                        "username" => $author,
                        "color" => "#ff4d4d",
                        "avatar" => $item["authorPhoto"]["thumbnails"][0]["url"] ?? null,
                        "message" => $msg,
                        "timestamp" => intval(($item["timestampUsec"] ?? (time() * 1000000)) / 1000)
                    ];
                }
            }
            $conts = $data["contents"]["liveChatRenderer"]["continuations"] ?? [];
            $nextContinuation = $conts[0]["invalidationContinuationData"]["continuation"] 
                             ?? $conts[0]["timedContinuationData"]["continuation"] 
                             ?? null;
        }
        
        return [
            "success" => true,
            "apiKey" => $apiKey,
            "messages" => array_slice($messages, -30),
            "continuation" => $nextContinuation
        ];
    } else {
        $apiKey = $_GET["key"] ?? "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
        $postUrl = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=" . $apiKey;
        $payload = json_encode([
            "context" => [
                "client" => [
                    "clientName" => "WEB",
                    "clientVersion" => "2.20240401.01.00",
                    "hl" => "en",
                    "gl" => "US"
                ]
            ],
            "continuation" => $continuation
        ]);
        
        $ch = curl_init($postUrl);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            "Content-Type: application/json",
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer: https://www.youtube.com/live_chat?v=" . $videoId,
            "Origin: https://www.youtube.com"
        ]);
        $res = curl_exec($ch);
        curl_close($ch);
        
        $json = json_decode($res, true);
        $messages = [];
        $nextContinuation = null;
        
        if ($json) {
            $actions = $json["continuationContents"]["liveChatContinuation"]["actions"] ?? [];
            foreach ($actions as $act) {
                $item = $act["addChatItemAction"]["item"]["liveChatTextMessageRenderer"] 
                     ?? $act["addChatItemAction"]["item"]["liveChatPaidMessageRenderer"] 
                     ?? null;
                if ($item) {
                    $author = $item["authorName"]["simpleText"] ?? "User";
                    $msg = "";
                    foreach ($item["message"]["runs"] ?? [] as $run) {
                        $msg .= $run["text"] ?? "";
                    }
                    $messages[] = [
                        "id" => $item["id"] ?? uniqid("yt_"),
                        "platform" => "youtube",
                        "username" => $author,
                        "color" => "#ff4d4d",
                        "avatar" => $item["authorPhoto"]["thumbnails"][0]["url"] ?? null,
                        "message" => $msg,
                        "timestamp" => intval(($item["timestampUsec"] ?? (time() * 1000000)) / 1000)
                    ];
                }
            }
            $nextConts = $json["continuationContents"]["liveChatContinuation"]["continuations"] ?? [];
            $nextContinuation = $nextConts[0]["invalidationContinuationData"]["continuation"] 
                             ?? $nextConts[0]["timedContinuationData"]["continuation"] 
                             ?? null;
        }
        
        return [
            "success" => true,
            "messages" => $messages,
            "continuation" => $nextContinuation
        ];
    }
}
