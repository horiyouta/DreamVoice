/* ============================================================================
   bgm-audio.js — 環境音ループ再生エンジン
   ----------------------------------------------------------------------------
   ./data/bgm.mp3 を、サイト上で最初にクリック（またはタップ）された瞬間から
   途切れなくループ再生する。単調な素材でも継ぎ目が目立たないよう、各ループの
   頭と終わりをクロスフェードさせながら次のループを重ねて鳴らす
   （= 一定間隔で次のイテレーションを先読みスケジュールする方式）。

   script.js 側で YouTube の iframe（歌ってみた本編など）が実際に再生状態に
   なったことを検知すると window.BGMAudio.duck(true) が呼ばれ、音量を
   なだらかかつ素早くほぼ無音まで落とす。動画が止まれば duck(false) で
   ゆっくり元の音量へ戻る。
   ========================================================================= */
window.BGMAudio = (function () {
    'use strict';

    var CONFIG = {
        URL:            'https://horiyouta-homepage.netlify.app/data/bgm.mp3',
        VOLUME:         0.28,   // 通常時の目標音量
        FADE_IN_MS:     1500,   // 初回再生時のフェードイン
        CROSSFADE:      1.5,    // ループ継ぎ目のクロスフェード秒数（素材の長さに応じて自動クランプ）
        DUCK_VOLUME:    0.05,   // ダッキング時の音量比率（VOLUME に対する係数）
        DUCK_DOWN_MS:   380,    // ダッキングIN（音量を下げる）の所要時間 = 「そこそこ速く」
        DUCK_UP_MS:     1100    // ダッキングOUT（音量を戻す）の所要時間 = ゆっくり自然に
    };

    var audioCtx = null, audioBuffer = null;
    var baseGain = null, duckGain = null;
    var started = false, loopStarted = false;
    var nextStartTime = 0, schedulerTimer = null;
    var isDucked = false;
    var enabled = true;

    function ensureContext() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        duckGain = audioCtx.createGain();
        duckGain.gain.value = 1;
        baseGain = audioCtx.createGain();
        baseGain.gain.value = 0;
        duckGain.connect(baseGain);
        baseGain.connect(audioCtx.destination);
    }

    function loadBuffer() {
        return fetch(CONFIG.URL)
            .then(function (r) { return r.arrayBuffer(); })
            .then(function (buf) { return audioCtx.decodeAudioData(buf); })
            .then(function (decoded) { audioBuffer = decoded; })
            .catch(function (err) {
                console.warn('[bgm-audio] ./data/bgm.mp3 の読み込みに失敗しました:', err);
            });
    }

    /* startAt から1ループ分をスケジュールし、頭と終わりを CROSSFADE 秒かけて
       フェードイン/アウトさせる。戻り値は「次のイテレーションを開始すべき時刻までの
       オフセット」（= dur - crossfade）。これを繰り返し積み上げることで、
       常に2つのイテレーションが重なり合った状態を保つ = 途切れない環境音になる。 */
    function scheduleIteration(startAt) {
        var dur = audioBuffer.duration;
        var xfade = Math.min(CONFIG.CROSSFADE, dur / 3);

        var src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        var g = audioCtx.createGain();
        src.connect(g);
        g.connect(duckGain);

        g.gain.setValueAtTime(0, startAt);
        g.gain.linearRampToValueAtTime(1, startAt + xfade);
        g.gain.setValueAtTime(1, startAt + dur - xfade);
        g.gain.linearRampToValueAtTime(0, startAt + dur);

        src.start(startAt);
        src.stop(startAt + dur + 0.1);

        return dur - xfade;
    }

    function schedulerTick() {
        while (nextStartTime < audioCtx.currentTime + 2.0) {
            nextStartTime += scheduleIteration(nextStartTime);
        }
    }

    function startLoop() {
        if (loopStarted) return;
        loopStarted = true;
        nextStartTime = audioCtx.currentTime + 0.05;
        schedulerTick();
        schedulerTimer = setInterval(schedulerTick, 250);

        var now = audioCtx.currentTime;
        baseGain.gain.cancelScheduledValues(now);
        baseGain.gain.setValueAtTime(0, now);
        baseGain.gain.linearRampToValueAtTime(CONFIG.VOLUME, now + CONFIG.FADE_IN_MS / 1000);
    }

    function start() {
        if (!enabled) return;
        if (started) {
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            return;
        }
        started = true;
        ensureContext();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        loadBuffer().then(function () {
            if (audioBuffer) startLoop();
        });
    }

    // 「サイト上の最初のクリック以降ずっと流れているように」= 最初の操作で開始
    window.addEventListener('pointerdown', start, { passive: true, once: true });
    window.addEventListener('click', start, { passive: true, once: true });

    return {
        configure: function (opts) { Object.assign(CONFIG, opts || {}); },

        /* on=true: YouTube再生中扱い → なめらかに素早くほぼ無音へ
           on=false: 通常音量へゆっくり復帰 */
        duck: function (on) {
            on = !!on;
            if (!audioCtx || !duckGain) { isDucked = on; return; }
            if (isDucked === on) return;
            isDucked = on;
            var now = audioCtx.currentTime;
            var target = on ? CONFIG.DUCK_VOLUME : 1;
            var durationMs = on ? CONFIG.DUCK_DOWN_MS : CONFIG.DUCK_UP_MS;
            duckGain.gain.cancelScheduledValues(now);
            duckGain.gain.setValueAtTime(duckGain.gain.value, now);
            duckGain.gain.linearRampToValueAtTime(Math.max(0.0001, target), now + durationMs / 1000);
        },
        // Dream Voice の設定画面向け。停止ではなく確実に無音化するので、
        // 既にスケジュール済みのクロスフェード音も残らない。
        setEnabled: function (on) {
            enabled = !!on;
            if (!audioCtx || !baseGain) return;
            var now = audioCtx.currentTime;
            baseGain.gain.cancelScheduledValues(now);
            baseGain.gain.setValueAtTime(baseGain.gain.value, now);
            baseGain.gain.linearRampToValueAtTime(enabled ? CONFIG.VOLUME : 0, now + 0.12);
            if (enabled && started) start();
        },

        debug: function () {
            return { started: started, loopStarted: loopStarted, isDucked: isDucked };
        }
    };
})();
