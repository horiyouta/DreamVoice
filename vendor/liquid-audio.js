/* ============================================================================
   liquid-audio.js — 水しぶき効果音エンジン（liquid-bg.js 連動版）
   ----------------------------------------------------------------------------
   analyze.py が sound.mp3 から作った sound_index.json（各フレームの時刻と
   RMS強度）を素材に、リアルタイム・グラニュラー合成で「水をかき混ぜる音」
   を鳴らす。

   旧デモ（fluid.html の水しぶきシンセ）との最大の違い：
     旧: マウスの移動量(px/frame)をそのまま「強さ」として使っていた
     新: window.LiquidBG.getWaveState() / onWave() を通じて、実際に
         liquid-bg.js のNavier-Stokesシミュレーションが計算した
         ポインタ位置の「水の速度・渦度」を読み、そこから強さを作る

   これにより、指を止めた瞬間にピタッと音が止まるのではなく、慣性で
   水が動き続けている間は音も続く／渦（curl）だけが残っている場面では
   低めの唸りが残る、といった「実際の水の動き」に音が追従するようになる。
   LiquidBG が使えない環境（WebGL非対応など）では、自動的に旧来の
   マウス速度ベースの簡易フォールバックに切り替わる。
   ========================================================================= */
window.LiquidAudio = (function () {
  'use strict';

  /* ============================================================
     CONFIG — ここで音の感度・音色を調整
     ============================================================ */
  var CONFIG = {
    INDEX_URL:      'https://horiyouta-homepage.netlify.app/data/sound_index.json',
    AUDIO_URL:      'https://horiyouta-homepage.netlify.app/data/sound.mp3',

    GRAIN_INTERVAL: 40,     // ms。この周期でフレーム(粒)を再生判定
    GRAIN_MIN:      0.02,   // strength がこれ未満なら無音
    TOLERANCE:      0.15,   // sound_index.json の中から intensity が近いフレームを探す許容誤差

    /* --- 実測の水の状態 → 0-1 の「強さ」への変換（要チューニング） ---
       liquid-bg.js の P_VEL / P_CURL の物理単位に依存するため、実機で
       console.log(window.LiquidAudio.debugLastWave) 等を見ながら
       SPEED_NORM / CURL_NORM を合わせ込むことを推奨。 */
    SPEED_NORM:     500,    // この速度で strength(速度成分) が概ね1.0
    CURL_NORM:      100,     // この渦度で strength(渦成分) が概ね1.0
    CURL_WEIGHT:    0.55,   // 渦成分を強さにどれだけ混ぜるか（速度が0でも渦だけで少し鳴る）
    STRENGTH_SMOOTH: 0.35,  // 強さの追加スムージング（0=なし,1=完全固定）

    /* --- フォールバック（LiquidBGの実測値が使えない場合） --- */
    FALLBACK_SPEED_NORM: 30, // px/frame 換算の簡易しきい値

    /* --- グラニュラー合成の音色 --- */
    PITCH_BASE:     0.95,
    PITCH_RAND:     0.10,
    PITCH_STRENGTH: 0.10,
    PITCH_SWIRL:    0.06,   // 渦の強さで追加のピッチ揺れ（かき混ぜ感の演出）
    FILTER_BASE:    300,
    FILTER_RANGE:   4000,
    GRAIN_DUR_MIN:  0.08,
    GRAIN_DUR_RAND: 0.05,
    VOL_BASE:       0.2,
    VOL_STRENGTH:   0.8,
    PAN_FROM_CURL:  0.8     // 渦の符号→左右パン（かき混ぜの回転方向を音の定位で表現）
  };

  var audioCtx = null, audioBuffer = null, soundIndex = null;
  var isAudioReady = false, started = false, enabled = true;
  var strength = 0;             // 0-1 に正規化された「現在の強さ」（滑らか化済み）
  var latestWave = null;        // LiquidBG から届いた最新の実測値
  var usingSimState = false;    // 実測ベースで動いているか（false ならフォールバック中）
  var grainTimer = null;

  /* フォールバック用の簡易ポインタ速度計測（LiquidBGが無い環境向け） */
  var fbPointer = { px: 0, py: 0, speed: 0, has: false };
  window.addEventListener('pointermove', function (e) {
    if (usingSimState) return; // 実測が使えている間はこちらは使わない
    if (!fbPointer.has) { fbPointer.px = e.clientX; fbPointer.py = e.clientY; fbPointer.has = true; return; }
    var dx = e.clientX - fbPointer.px, dy = e.clientY - fbPointer.py;
    fbPointer.speed = Math.sqrt(dx * dx + dy * dy);
    fbPointer.px = e.clientX; fbPointer.py = e.clientY;
    ensureStarted();
  }, { passive: true });

  function ensureStarted() {
    if (started) { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); return; }
    started = true;
    start();
  }
  window.addEventListener('pointerdown', ensureStarted, { passive: true });
  window.addEventListener('pointermove', ensureStarted, { passive: true, once: true });

  /* ============================================================
     ロード
     ============================================================ */
  function loadAssets() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    var idxP = fetch(CONFIG.INDEX_URL).then(function (r) { return r.json(); }).then(function (j) { soundIndex = j; });
    var sndP = fetch(CONFIG.AUDIO_URL).then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) { return audioCtx.decodeAudioData(buf); })
      .then(function (decoded) { audioBuffer = decoded; });

    return Promise.all([idxP, sndP]).then(function () {
      isAudioReady = true;
    }).catch(function (err) {
      console.warn('[liquid-audio] アセットの読み込みに失敗しました:', err);
    });
  }

  /* ============================================================
     LiquidBG からの実測値購読
     ============================================================ */
  function subscribeToLiquidBG() {
    if (!window.LiquidBG || typeof window.LiquidBG.onWave !== 'function') return false;
    window.LiquidBG.onWave(function (state) {
      latestWave = state;
      usingSimState = true;
      ensureStarted();
    });
    return true;
  }

  /* LiquidBG の読み込みタイミングが前後しても取りこぼさないよう、
     少し待ってからもう一度だけ購読を試みる（liquid-bg.js は非同期に
     WebGLコンテキストを初期化するため、ready フラグが後から立つ） */
  function trySubscribeWithRetry(attemptsLeft) {
    if (subscribeToLiquidBG()) return;
    if (attemptsLeft <= 0) return;
    setTimeout(function () { trySubscribeWithRetry(attemptsLeft - 1); }, 300);
  }

  /* ============================================================
     強さ(strength)の計算
     ============================================================ */
  function computeTargetStrength() {
    if (usingSimState && latestWave) {
      var speedPart = Math.min(1.0, latestWave.speed / CONFIG.SPEED_NORM);
      var curlPart  = Math.min(1.0, Math.abs(latestWave.curl) / CONFIG.CURL_NORM);
      return Math.max(speedPart, curlPart * CONFIG.CURL_WEIGHT);
    }
    // フォールバック：旧デモと同じくマウス速度そのもの
    var s = Math.min(1.0, fbPointer.speed / CONFIG.FALLBACK_SPEED_NORM);
    fbPointer.speed *= 0.85; // 静止したら減衰（実測モードでは物理シムが自然に減衰するので不要）
    return s;
  }

  /* ============================================================
     グラニュラー再生
     ============================================================ */
  function playGrain(startTime, str, curl) {
    var source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    var swirl = Math.min(1.0, Math.abs(curl || 0) / CONFIG.CURL_NORM);
    source.playbackRate.value =
      CONFIG.PITCH_BASE + Math.random() * CONFIG.PITCH_RAND +
      str * CONFIG.PITCH_STRENGTH + swirl * CONFIG.PITCH_SWIRL;

    var filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = CONFIG.FILTER_BASE + Math.pow(str, 2) * CONFIG.FILTER_RANGE;

    var gainNode = audioCtx.createGain();
    var now = audioCtx.currentTime;
    var grainDuration = CONFIG.GRAIN_DUR_MIN + Math.random() * CONFIG.GRAIN_DUR_RAND;
    var volume = Math.min(1.0, CONFIG.VOL_BASE + str * CONFIG.VOL_STRENGTH);
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(volume, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + grainDuration);

    source.connect(filter);
    filter.connect(gainNode);

    /* 渦の回転方向をステレオの左右へ（かき混ぜている方向を音の定位で表現） */
    if (audioCtx.createStereoPanner) {
      var panner = audioCtx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, (curl || 0) / CONFIG.CURL_NORM * CONFIG.PAN_FROM_CURL));
      gainNode.connect(panner);
      panner.connect(audioCtx.destination);
    } else {
      gainNode.connect(audioCtx.destination);
    }

    source.start(now, startTime, grainDuration);
  }

  function tick() {
    if (!enabled || !isAudioReady) return;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

    var target = computeTargetStrength();
    strength += (target - strength) * (1 - CONFIG.STRENGTH_SMOOTH);
    if (strength < CONFIG.GRAIN_MIN) return;

    var candidates = soundIndex.frames.filter(function (f) {
      return Math.abs(f.intensity - strength) < CONFIG.TOLERANCE;
    });
    if (!candidates.length) return;

    var frame = candidates[Math.floor(Math.random() * candidates.length)];
    var curl = (usingSimState && latestWave) ? latestWave.curl : 0;
    playGrain(frame.time, strength, curl);
  }

  /* ============================================================
     制御
     ============================================================ */
  function start() {
    if (!audioCtx) {
      loadAssets().then(function () {
        if (!grainTimer) grainTimer = setInterval(tick, CONFIG.GRAIN_INTERVAL);
      });
    } else if (!grainTimer) {
      grainTimer = setInterval(tick, CONFIG.GRAIN_INTERVAL);
    }
  }

  function stop() {
    if (grainTimer) { clearInterval(grainTimer); grainTimer = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else if (started && enabled) start();
  });

  trySubscribeWithRetry(6);

  return {
    /* オプションで INDEX_URL / AUDIO_URL 等を上書きしてから使う場合に */
    configure: function (opts) { Object.assign(CONFIG, opts || {}); },
    setEnabled: function (on) {
      enabled = !!on;
      if (enabled) { if (started) start(); } else stop();
    },
    /* デバッグ用：現在の実測値と強さを見る */
    debug: function () {
      return { usingSimState: usingSimState, latestWave: latestWave, strength: strength, isAudioReady: isAudioReady };
    }
  };
})();