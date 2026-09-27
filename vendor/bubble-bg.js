/* ============================================================================
   bubble-bg.js — DREAM CYBER BUBBLE v3「クリスタル」（背景レイヤー専用）
   ----------------------------------------------------------------------------
   horiyouta のホームページ最奥レイヤー。#bubbleGl にオフスクリーン描画し、
   liquid-bg.js が毎フレームテクスチャとして読み取る（画面には #liquid のみ）。

   v2 → v3 の設計変更（狙い：AI生成静止画 imgB の「明るく・鮮明で・色が濃い」
   質感へ寄せる）:

   1) 解像度を根本から引き上げた
      v2 は短辺 450px × quality 0.75 ＝ 実質 337px で描いたものを liquid 側で
      全画面へ拡大していた（3〜5倍拡大）。これが「全体的にぼやけている」最大の
      原因。v3 は短辺 1000px まで（DPR 上限 1.25）＋シーンRTは等倍。さらに
      実測フレーム時間で自動増減する適応スケーラを載せたので、重い端末でも
      勝手に落ちて軽い端末では上限まで上がる。

   2) 背景の墨流し（シルク）を「環境マップ経由」から「画面空間で毎ピクセル評価」へ
      v2 は 512x256 の等距円筒マップを引き伸ばしていたため、画面上の実効解像度は
      横 512*(FOV/360) ≒ 90px 程度しかなかった。v3 は視線方向で直接評価するので
      シルクの筋が常にピクセル等倍で鮮明。環境マップ(1024x512)は
      「シャボン玉の映り込み専用」として残す（そこはボケていて構わないため）。

   3) メタボール・レイマーチ → 解析的な楕円体シャボン玉へ全面置換
      v2 は 12 個の球を smin で融合した1つの塊を 18 ステップでスフィアトレースして
      いた。重いうえに輪郭がにじみ、imgB のような「粒の立った独立したシャボン玉」に
      ならなかった。v3 は 1 球＝1 ビルボード四角形で、フラグメント側は
      レイ-楕円体の解析交差（＋fwidth によるアナリティック AA）。
      結果：解像度に依存せず輪郭が完全にシャープ、コストは «玉が映っている画素» 
      だけ、玉の数も増やせる（24個）。

   4) シャボン玉の合成は「乗算パス → 加算パス」の2パス構成
      pass A: blend(ZERO, SRC_COLOR) で薄膜の透過率 T を背景に乗算（順序非依存）
      pass B: blend(ONE, ONE) で反射・ハイライト・リムを加算（順序非依存）
      final = bg * ΠT + ΣE となり、CPU 側のソートが一切不要。
      T は波長ごとに求めるので「透過側は反射色の補色になる」本物の挙動が出る。

   5) 薄膜干渉を Airy の多重反射式に置き換え
      v2 は 0.5-0.5*cos(位相) の2光束近似だったので、斜めから見たときに
      «縁が白く飛ぶ» 挙動が出なかった。v3 は R = F sin²(δ/2) / (1 + F sin²(δ/2))、
      F = 4r/(1-r)²（r は Schlick フレネル）。かすめ角で r→1 ⇒ R→1 となり、
      imgB のような «白く光るくっきりしたリム» が物理的に自動で出る。

   6) 発色とトーン
      パレットに «白・杏（オレンジ）・ミント» を追加、暖色ゾーンのマスクを新設。
      トーンマップは露出 1.28／ハイライトを白へ抜く量を増やし、持ち上げていた
      黒レベル（v2: +0.085,0.060,0.105）を 1/3 に削減。眠さの主因を除去した。

   7) ブルームを «締めた» うえでクロス・ストリークを追加
      v2 は広いミップまで等倍で足していたので画面全体に靄がかかっていた。
      v3 は上げ合成のたびに 0.62 倍して細いグローに寄せ、代わりに
      水平／垂直のストリークパスを追加。imgB のキラッとした星形の光条が出る。

   window.BubbleBG（liquid-bg.js から参照される外部インターフェース。不変）:
     .canvas / .ready / .tick
   追加（任意・チューニング用）:
     .look      … 下の LOOK と同じオブジェクト（実行中に書き換えると即反映）
     .setLook(o)… まとめて反映
     .stats()   … {fps, w, h, scale} を返す
   ========================================================================= */
window.BubbleBG = window.BubbleBG || { canvas: null, ready: false, tick: 0 };

(function(){
'use strict';

/* ============================================================
   ★ ここだけ触れば絵作りを調整できます（実行中の変更も反映）
   ============================================================ */
const LOOK = {
  /* --- 明るさ・色 --- */
  exposure:    0.70,   // 全体の明るさ
  preSat:      1.20,   // ★トーンマップ «前» の彩度。色の濃さはここが本命。
                       //   トーンマップ後に上げても、飛んだ画素の色は戻らないため
  contrast:    1.25,   // 1.0 で無効。上げるとメリハリ（＝ぼやけ感の解消）
  saturation:  1.10,    // トーンマップ後の仕上げ彩度（微調整用）
  lift:        0.030,  // 黒の持ち上げ（霞ませたい時だけ上げる）
  hueBias:     0.004,  // パレット全体の色相回し
  silkWhite:   0.40,   // シルクの «白い折り目» の量。1.0 超で白く、0 で色だけ

  /* --- シャボン玉 --- */
  count:       24,     // 玉の数（MAXB 以下）
  filmBoost:   4.5,    // 薄膜干渉の強さ。物理値は 1.0（＝地味）。5〜8 が «虹色» 
  filmMin:     170.0,  // 膜厚レンジ nm（小さいほど淡い／大きいほど高次の細かい縞）
  filmMax:     620.0,
  reflGain:    1.15,   // 映り込みの強さ
  rimGain:     0.85,   // 輪郭の白い光（ここが imgB らしさの核）
  glitter:     1.00,   // 膜表面のキラキラ
  lensWarp:    0.55,   // 玉のフチで背景が引っぱられる量（0 で無効）

  /* --- 光・エフェクト --- */
  bloom:       0.62,   // ブルーム量（v2 は 0.9 ＝ 靄の原因）
  streak:      0.55,   // 十字ストリーク（星形の光条）
  flare:       0.85,   // キーライトのレンズフレア
  lines:       true,   // サイバー線
  dust:        true,   // 舞う塵・スパークル
  veins:       0.85,   // 電気信号の脈
  vignette:    0.06,   // 周辺減光（v2 は 0.10）
  grain:       0.008
};

function boot(){

/* ============================================================
   0. canvas
   ============================================================ */
const canvas = document.getElementById('bubbleGl') || (function(){
  const c = document.createElement('canvas');
  c.id = 'bubbleGl';
  document.body.insertBefore(c, document.body.firstChild);
  return c;
})();
window.BubbleBG.canvas = canvas;

/* --- 解像度ポリシー ---------------------------------------------------
   v2: DPR_MAX 0.75 / 短辺 450 / さらに quality 0.75 ＝ 実効 337px
   v3: DPR_MAX 1.25 / 短辺 1000 / シーンRTは等倍。適応スケーラで自動増減。 */
const RES = {
  DPR_MAX:        1.25,
  SHORT_SIDE_MAX: 1000,
  SHORT_SIDE_MIN: 400,
  SCALE_MIN:      0.45,
  SCALE_MAX:      1.00
};
const ENV_W = 1024, ENV_H = 512;   // 映り込み専用の等距円筒マップ
const MAXB  = 24;

/* ============================================================
   1. WebGL2
   ============================================================ */
const PDB = !!window.BG_PRESERVE_DRAWING_BUFFER;
const ATTEMPTS = [
  { antialias:false, alpha:false, depth:false, stencil:false, powerPreference:'high-performance', preserveDrawingBuffer: PDB },
  { antialias:false, alpha:false, depth:false, stencil:false, preserveDrawingBuffer: PDB },
  { antialias:false, preserveDrawingBuffer: PDB },
  { preserveDrawingBuffer: PDB }
];
let gl = null;
for(let i=0;i<ATTEMPTS.length;i++){
  try{ gl = canvas.getContext('webgl2', ATTEMPTS[i]); }catch(e){}
  if(gl) break;
}
if(!gl){
  console.warn('[bubble-bg] WebGL2 is unavailable — falling back to the CSS gradient background.');
  return;
}

/* ============================================================
   2. RT ヘルパ & HDR 対応チェック
   ============================================================ */
const extF = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');

function makeRT(w, h, isFloat){
  w = Math.max(1, w|0); h = Math.max(1, h|0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if(isFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8,   w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const ok = status === gl.FRAMEBUFFER_COMPLETE;
  if(!ok) console.warn('[bubble-bg] FBO incomplete (' + w + 'x' + h + (isFloat?' f16':'') + '): status ' + status);
  return { tex, fb, w, h, ok };
}
function freeRT(rt){ if(!rt) return; gl.deleteFramebuffer(rt.fb); gl.deleteTexture(rt.tex); }

let HDR = false;
if(extF){
  const probe = makeRT(4, 4, true);
  HDR = probe.ok;
  freeRT(probe);
}
if(!HDR) console.info('[bubble-bg] float render targets unavailable — using scaled LDR pipeline.');

/* LDR フォールバック時は RGBA8 に 1/4 スケールで格納して 0..4 の疑似HDRを確保する。
   乗算（透過）はスケール不変、加算（反射）は同じ係数を掛ければ線形性が保たれるので
   2パス合成はそのまま成立する。 */
const SS    = HDR ? 1.0 : 0.25;
const SSINV = 1.0 / SS;

/* ============================================================
   3. シェーダ compile/link
   ============================================================ */
function compile(type, src, name){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    console.error('[bubble-bg] shader compile failed: ' + name + '\n' + (gl.getShaderInfoLog(s)||'(no log)'));
    throw new Error('shader compile failed: ' + name);
  }
  return s;
}
function link(vsSrc, fsSrc, name){
  const vs = compile(gl.VERTEX_SHADER, vsSrc, name+':VS');
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc, name+':FS');
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
    console.error('[bubble-bg] program link failed: ' + name + '\n' + (gl.getProgramInfoLog(p)||'(no log)'));
    throw new Error('program link failed: ' + name);
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  const P = { p: p, u: {} };
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for(let i=0;i<n;i++){
    const info = gl.getActiveUniform(p, i);
    const nm = info.name.replace(/\[0\]$/, '');
    P.u[nm] = gl.getUniformLocation(p, nm);
  }
  return P;
}

let buildOK = true;
let progEnv, progBG, progBubble, progCopy, progDown, progUp, progStreak, progComposite, progLine, progDust;

try{

/* ============================================================
   4. シェーダソース
   ============================================================ */
const HEAD = `#version 300 es
precision highp float;
precision highp int;
#define PI 3.14159265359
#define TAU 6.28318530718
#define MAXB ${MAXB}
#define HDR ${HDR?1:0}
#define SSCALE ${SS.toFixed(6)}
#define SSINV ${SSINV.toFixed(6)}
`;

/* ---------- 共通ライブラリ（uniform を含まない純関数のみ） ---------- */
const LIB = `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash13(vec3 p){
  p = fract(p*0.3183099 + vec3(0.71,0.113,0.419));
  p *= 17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
}
float noise3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = mix(mix(hash13(i+vec3(0,0,0)), hash13(i+vec3(1,0,0)), f.x),
                mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x),
                mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y);
  return mix(a,b,f.z);
}
float fbm2(vec3 p){
  float s = 0.0, a = 0.58;
  for(int i=0;i<2;i++){ s += a*noise3(p); p = p*2.05 + vec3(3.1,1.7,9.2); a *= 0.5; }
  return s;
}
float fbm3(vec3 p){
  float s = 0.0, a = 0.54;
  for(int i=0;i<3;i++){ s += a*noise3(p); p = p*2.04 + vec3(3.1,1.7,9.2); a *= 0.5; }
  return s;
}
float fbm4(vec3 p){
  float s = 0.0, a = 0.52;
  for(int i=0;i<4;i++){ s += a*noise3(p); p = p*2.03 + vec3(3.1,1.7,9.2); a *= 0.5; }
  return s;
}

/* ---- パレット（v3）--------------------------------------------------
   v2 は «桜/ラベンダー/すみれ/空/藤/桃» の 6 色で、全体に紫へ寄っていた。
   imgB は «白・水色・ミント・桃・杏(オレンジ)» の幅があるので、白側と暖色側を
   広げて、平均輝度も 0.78 → 0.90 前後まで引き上げている。 */
vec3 dreamPalette(float t){
  t = fract(t);
  float x = t*6.0; float i = floor(x); float f = fract(x); f = f*f*(3.0-2.0*f);
  /* v3.0 は最小チャンネルが 0.74〜0.82 と «白に近すぎる» パステルだったため、
     どれだけ彩度を上げても灰色寄りにしかならなかった。彩度を持たせたうえで
     輝度は高いまま（min 0.52〜0.66）に取り直している。 */
  vec3 P0 = vec3(1.00,0.66,0.82);   /* 桜 */
  vec3 P1 = vec3(1.00,0.56,0.95);   /* 桃紫 */
  vec3 P2 = vec3(0.72,0.64,1.00);   /* 藤 */
  vec3 P3 = vec3(0.52,0.86,1.00);   /* 水色 */
  vec3 P4 = vec3(0.72,1.00,0.93);   /* ミント */
  vec3 P5 = vec3(1.00,0.82,0.58);   /* 杏 */
  vec3 c0, c1;
  if(i<0.5){c0=P0;c1=P1;} else if(i<1.5){c0=P1;c1=P2;} else if(i<2.5){c0=P2;c1=P3;}
  else if(i<3.5){c0=P3;c1=P4;} else if(i<4.5){c0=P4;c1=P5;} else {c0=P5;c1=P0;}
  return mix(c0,c1,f);
}

vec2 envUV(vec3 d){ return vec2(atan(d.z,d.x)/TAU + 0.5, asin(clamp(d.y,-1.0,1.0))/PI + 0.5); }
#if HDR
vec4 encodeEnv(vec3 c, float m){ return vec4(c, m); }
vec4 decodeEnv(vec4 e){ return e; }
#else
vec4 encodeEnv(vec3 c, float m){ return vec4(sqrt(max(c,0.0)/8.0), m); }
vec4 decodeEnv(vec4 e){ return vec4(e.rgb*e.rgb*8.0, e.a); }
#endif

/* ---- 墨流し（シルク）のスカラー場 ------------------------------------
   戻り値 x=主スカラー場 m / y=稜線 w3 / z=稜線 w2 / w=微細リッジ
   v2 は 3 段ドメインワープ×fbm4（＝20 noise）だったが、環境マップ (512x256)
   経由で引き伸ばされていたため «高密度に計算したのに結果はボケる» 状態だった。
   v3 は 13 noise に落とす代わりに画面空間で等倍評価する（＝同じ予算で
   実効解像度が 10 倍以上）。鮮明さは «稜線 crest» を強調して補う。 */
vec4 silkField(vec3 d, float t){
  vec3 p = d*1.9;
  float w1 = fbm2(p*0.90 + vec3(0.0, t*0.020, 0.0));
  float w2 = fbm2(p*0.90 + vec3(5.1,2.3,7.4) - vec3(t*0.016, 0.0, 0.0));
  vec3  q  = p + 2.15*vec3(w1-0.5, w2-0.5, (w1-w2)*0.9);
  float w3 = fbm3(q*1.22 + vec3(1.7,9.2,3.1) + vec3(0.0, 0.0, t*0.013));
  vec3  r  = q + 1.45*vec3(w3-0.5, (w1-0.5)*0.75, (w3-w2));
  float m  = fbm4(r + vec3(0.0, t*0.008, 0.0));
  float fn = fbm2(r*3.30 + vec3(2.7, 0.0, t*0.020));
  return vec4(m, w3, w2, fn);
}

/* 等高線状の «細い折り目»。
   v3.0 は pow(1-|2w-1|, 11) で稜線を作っていたが、fbm の値は平均 0.46±0.09 に
   集中するため 1-|2w-1| はほぼ常に 0.9 前後 ＝ 画面全体が «稜線» 扱いになり、
   白を 1.6 倍で加算していた結果、背景全体が白く濁って彩度が死んでいた
   （実測: 稜線項の平均が 0.29、線形輝度が base 1.02 → 1.60 に増加）。
   fract() 等高線なら分布に関係なく «太さ w の細い線» が保証される。 */
float contourLine(float v, float freq, float w){
  float f = abs(fract(v*freq) - 0.5);
  return 1.0 - smoothstep(0.0, clamp(w, 0.004, 0.45), f);
}

vec3 silkColor(vec4 f, vec3 d, float t, float hueBias, float aa, float whiteAmt){
  float m = f.x, w3 = f.y, w2 = f.z, fn = f.w;

  /* fbm の実測レンジ (m:0.26〜0.73 / w3:0.23〜0.67 / w2:0.23〜0.54) に合わせて
     正規化する。ここがずれていると «色相が一部しか使われない» ことになる。 */
  float mn = clamp((m  - 0.28)/0.42, 0.0, 1.0);
  float n3 = clamp((w3 - 0.25)/0.40, 0.0, 1.0);
  float n2 = clamp((w2 - 0.23)/0.30, 0.0, 1.0);

  /* 色相は複数の場を混ぜて広く回す。1画面に桃・水色・藤・杏が同居する */
  float hue = mn*0.72 + 0.34*(n3-0.5) + 0.10*(n2-0.5) + 0.035*sin(t*0.05) + hueBias;
  vec3 col = dreamPalette(hue);

  /* 明暗は «白を足す» のではなく «色のまま» 上下させる（彩度が死なない） */
  col *= 0.45 + 0.85*smoothstep(0.05, 0.95, mn);

  /* 折り目。面積が小さいので白を足しても全体は濁らない */
  float e1 = contourLine(w3,  5.5, aa* 5.5 + 0.034);
  float e2 = contourLine(m,  13.0, aa*13.0 + 0.024);
  float e3 = contourLine(fn,  9.0, aa*30.0 + 0.020);   /* fn は変化が速いので低い周波数で */
  col += vec3(1.00,0.97,1.00)*e1*0.90*whiteAmt;
  col += vec3(1.00,0.90,0.99)*e2*0.42*whiteAmt;
  col += vec3(1.00,0.86,0.74)*e3*0.22*whiteAmt;

  /* 暖色ゾーン：imgB にある «ところどころのオレンジ／杏» を作る（乗算なので濁らない） */
  float warm = smoothstep(0.62, 1.00, n2);
  col = mix(col, col*vec3(1.35,0.92,0.62), 0.60*warm);

  /* 上方が明るい */
  col *= 0.88 + 0.28*smoothstep(-0.95, 0.95, d.y);
  return col;
}
`;

/* ---------- ライト系（uLightDir / uLightCol を使う関数群） ---------- */
const LIGHTLIB = `
uniform vec3 uLightDir[3];
uniform vec3 uLightCol[3];

/* 解像度に依存しない «鋭い» 光源コア */
vec3 lightCores(vec3 d){
  vec3 s = vec3(0.0);
  for(int i=0;i<3;i++){
    float c = 1.0 - max(dot(d, uLightDir[i]), 0.0);
    s += uLightCol[i]*(4.6*exp(-c*1600.0) + 1.10*exp(-c*240.0) + 0.30*exp(-c*34.0));
  }
  return s;
}
/* 広いソフトハロー */
vec3 halos(vec3 d){
  vec3 s = vec3(0.0);
  for(int i=0;i<3;i++){
    float c = 1.0 - max(dot(d, uLightDir[i]), 0.0);
    s += uLightCol[i]*(1.40*exp(-c*46.0) + 0.55*exp(-c*9.0) + 0.18*exp(-c*2.1));
  }
  return s;
}
/* 被写界深度風のボケ玉＋小さな星 */
vec3 bokehField(vec3 d, float t, float hueBias){
  vec3 s = vec3(0.0);
  for(int i=0;i<10;i++){
    float fi = float(i);
    float h1=hash11(fi*12.9+3.1), h2=hash11(fi*7.7+9.3), h3=hash11(fi*5.3+1.7), h4=hash11(fi*3.1+6.6);
    float az = h1*TAU + t*(0.004+0.006*h2);
    float el = (h2-0.5)*PI*0.8 + 0.02*sin(t*0.1+h3*9.0);
    vec3 od = vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az));
    float c = 1.0 - max(dot(d, od), 0.0);
    float r = mix(0.0006, 0.0045, h4*h4);
    float disc = smoothstep(r, r*0.72, c);
    float rim  = smoothstep(r*0.5, r, c)*disc;
    float tw = 0.75 + 0.45*sin(t*0.35 + h1*21.0);
    vec3 oc = dreamPalette(h3*0.55 + hueBias);
    s += oc*((disc*(0.60+0.9*rim))*mix(0.35,1.0,h4) + 0.13*exp(-c/r*0.6))*tw;
    s += oc*step(h4,0.5)*2.6*exp(-c*9000.0)*tw;
  }
  return s;
}
/* 墨流しスカラー場から解析復元する電気信号の脈 */
vec3 veins(float m, vec3 d, float t, float w){
  float lv = m*26.0 - t*0.10;
  float line = 1.0 - smoothstep(0.0, w, abs(fract(lv)-0.5));
  float lv2 = m*74.0 + t*0.16;
  float line2 = 1.0 - smoothstep(0.0, w*2.5, abs(fract(lv2)-0.5));
  float pulse = pow(0.5+0.5*sin(m*38.0 + dot(d,vec3(1.3,0.7,1.9))*2.0 - t*0.7), 16.0);
  vec3 vc = mix(vec3(0.52,0.97,1.00), vec3(1.00,0.70,0.96), 0.5+0.5*sin(m*11.0+t*0.15));
  float band = smoothstep(0.20,0.48,m)*smoothstep(0.99,0.70,m);
  return vc*band*(line*(0.16 + 2.2*pulse) + line2*0.07);
}
`;

/* ---------- パステル向けトーンマップ ---------- */
const GRADE = `
uniform float uExposure, uContrast, uSat, uPreSat, uLift;
const vec3 LUMA = vec3(0.2126,0.7152,0.0722);
vec3 grade(vec3 c){
  c = max(c, 0.0)*uExposure;

  /* 1) トーンマップ «前» に彩度を上げる。
     後段で上げても、飛んでしまった画素の色情報はもう残っていない。 */
  float l0 = dot(c, LUMA);
  c = max(mix(vec3(l0), c, uPreSat), 0.0);

  /* 2) 輝度だけをトーンマップし、RGB の比率はそのまま保つ。
     v3.0 の per-channel Reinhard は明るい画素ほど3チャンネルが同時に 1 へ
     漸近する＝白へ吸い込まれるため、背景が灰色に見える主因だった。 */
  float l = dot(c, LUMA);
  float W = 3.4;
  float lt = l*(1.0 + l/(W*W))/(1.0 + l);
  c *= lt/max(l, 1e-5);

  /* 3) 色域からはみ出した分だけソフトに白へ寄せる（ハイライトの «抜け»） */
  float mx = max(c.r, max(c.g, c.b));
  c = mix(c, vec3(lt), clamp((mx - 1.0)*0.9, 0.0, 1.0));

  c = pow(clamp(c, 0.0, 1.0), vec3(1.0/2.24));
  c = clamp((c-0.48)*uContrast + 0.50, 0.0, 1.0);
  float l2 = dot(c, LUMA);
  c = clamp(mix(vec3(l2), c, uSat), 0.0, 1.0);
  c = c*(1.0-uLift) + vec3(uLift*0.94, uLift*0.78, uLift*1.22);
  return c;
}
`;

const VS_QUAD = HEAD + `
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

/* ---------- pass 0: 環境マップ（シャボン玉の映り込み専用） ---------- */
const FS_ENV = HEAD + LIB + LIGHTLIB + `
uniform vec2  uEnvRes;
uniform float uTime, uHueBias, uSilkWhite;
out vec4 fragColor;
void main(){
  vec2 uv = gl_FragCoord.xy/uEnvRes;
  float az = (uv.x-0.5)*TAU, el = (uv.y-0.5)*PI;
  vec3 d = vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az));
  vec4 f = silkField(d, uTime);
  vec3 col = silkColor(f, d, uTime, uHueBias, fwidth(f.x), uSilkWhite);
  col += halos(d);
  col += bokehField(d, uTime, uHueBias)*0.85;
  fragColor = encodeEnv(max(col, vec3(0.0)), f.x);
}`;

/* ---------- pass 1: 背景（画面空間・等倍＝ここが鮮明さの本体） ---------- */
const FS_BG = HEAD + LIB + LIGHTLIB + `
uniform vec2  uRes;
uniform vec3  uCamPos, uRight, uUp, uFwd;
uniform float uFocal, uTime, uHueBias, uVeins, uFlare, uSilkWhite;
out vec4 fragColor;

/* キーライトのレンズフレア（放射シャフト＋十字ストリーク） */
vec3 keyFlare(vec2 uv, float t){
  vec3 L = uLightDir[0];
  float c = dot(L, uFwd);
  if(c < 0.05) return vec3(0.0);
  vec2 luv = vec2(dot(L,uRight), dot(L,uUp))/c*uFocal;
  vec2 dv = uv - luv;
  float r = length(dv) + 1e-4;
  float ang = atan(dv.y, dv.x);
  float N = 28.0;
  float a1 = ang/TAU*N + t*0.03; float i1 = floor(a1), f1 = fract(a1); f1 = f1*f1*(3.0-2.0*f1);
  float n1 = mix(hash11(mod(i1,N)*1.7+2.0), hash11(mod(i1+1.0,N)*1.7+2.0), f1);
  float a2 = ang/TAU*14.0 - t*0.02; float i2 = floor(a2), f2 = fract(a2); f2 = f2*f2*(3.0-2.0*f2);
  float n2 = mix(hash11(mod(i2,14.0)*3.1+7.0), hash11(mod(i2+1.0,14.0)*3.1+7.0), f2);
  float rays = pow(n1*0.6 + n2*0.4, 2.5);
  float shaft  = rays*exp(-r*1.8)*smoothstep(0.0,0.10,r)*0.50;
  float streak = (pow(abs(cos(ang)),300.0) + 0.5*pow(abs(sin(ang)),300.0))*exp(-r*5.0)*0.70;
  float glow   = 0.12*exp(-r*r*9.0);
  return uLightCol[0]*(shaft + streak + glow);
}

void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (fc - 0.5*uRes)/uRes.y;
  vec3 rd = normalize(uRight*uv.x + uUp*uv.y + uFwd*uFocal);

  vec4 f = silkField(rd, uTime);
  vec3 col = silkColor(f, rd, uTime, uHueBias, fwidth(f.x), uSilkWhite);

  /* 脈は fwidth で解析 AA（等倍評価なので 1px 幅でも滑らかに出る） */
  float vw = fwidth(f.x)*22.0 + 0.0035;
  col += veins(f.x, rd, uTime, vw)*uVeins;

  col += halos(rd);
  col += lightCores(rd);
  col += bokehField(rd, uTime, uHueBias);
  col += keyFlare(uv, uTime)*uFlare;

  fragColor = vec4(col*SSCALE, 1.0);
}`;

/* ---------- pass 2: シャボン玉（解析的楕円体・ビルボード） ----------
   uPass = 0 : 透過率 T を出力 → blend(ZERO, SRC_COLOR) で背景に乗算
   uPass = 1 : 反射・ハイライト E を出力 → blend(ONE, ONE) で加算
   どちらも順序非依存なので CPU 側のソートは不要。                     */
const VS_BUBBLE = HEAD + `
uniform vec3  uCamPos, uRight, uUp, uFwd;
uniform float uFocal, uAspect;
uniform vec4  uBPos[MAXB];
uniform vec4  uBScale[MAXB];
flat out int  vIdx;
void main(){
  int vid  = gl_VertexID;
  int inst = vid/6;
  int c    = vid - inst*6;
  vec2 q;
  if(c==0 || c==3)       q = vec2(-1.0,-1.0);
  else if(c==1)          q = vec2( 1.0,-1.0);
  else if(c==2 || c==4)  q = vec2( 1.0, 1.0);
  else                   q = vec2(-1.0, 1.0);

  vec3  C = uBPos[inst].xyz;
  float R = uBPos[inst].w;
  vec3  S = uBScale[inst].xyz;
  float Rmax = R*max(S.x, max(S.y, S.z));

  float zc = dot(C - uCamPos, uFwd);
  zc = max(zc, Rmax*1.12);
  /* 球のシルエットは中心を通る面の半径より大きく見えるので補正する */
  float k    = Rmax/zc;
  float grow = 1.0/sqrt(max(1.0 - k*k, 0.04));
  float half0 = Rmax*grow*1.06;

  vec3 P = C + uRight*(q.x*half0) + uUp*(q.y*half0);
  vec3 v = P - uCamPos;
  float a = dot(v,uRight), b = dot(v,uUp), cz = max(dot(v,uFwd), 0.02);
  gl_Position = vec4(2.0*uFocal*a/(uAspect*cz), 2.0*uFocal*b/cz, 0.0, 1.0);
  vIdx = inst;
}`;

const FS_BUBBLE = HEAD + LIB + LIGHTLIB + `
uniform vec2  uRes;
uniform vec3  uCamPos, uRight, uUp, uFwd;
uniform float uFocal, uTime, uHueBias;
uniform vec4  uBPos[MAXB];
uniform vec4  uBScale[MAXB];
uniform vec4  uBParam[MAXB];   /* x=膜厚基準nm  y=個体シード  z=干渉ゲイン  w=キラキラ量 */
uniform int   uPass;
uniform float uFilmBoost, uReflGain, uRimGain, uGlitter, uLensWarp;
uniform sampler2D uEnv, uBG;
flat in int vIdx;
out vec4 fragColor;

vec3 envC(vec3 d){ return decodeEnv(textureLod(uEnv, envUV(d), 0.0)).rgb; }

/* Airy の多重反射式による薄膜反射率（v2 の 2 光束近似の置き換え）。
   かすめ角では r→1 ⇒ R→1 となるので «白く光るリム» が自動で出る。 */
vec3 filmR(float cosT, float thick, float boost){
  float n2 = 1.34;
  float sinT2 = (1.0 - cosT*cosT)/(n2*n2);
  float cosT2 = sqrt(max(1.0 - sinT2, 0.0));
  float opd   = 2.0*n2*thick*cosT2;
  vec3  lam   = vec3(680.0, 545.0, 445.0);
  vec3  dlt   = TAU*opd/lam;

  float r0 = 0.02;                                     /* 空気→水の垂直入射反射率 */
  float rf = r0 + (1.0-r0)*pow(1.0-cosT, 5.0);         /* Schlick */
  float F  = 4.0*rf/max((1.0-rf)*(1.0-rf), 1e-4)*boost;

  vec3 s2 = sin(dlt*0.5); s2 *= s2;
  return clamp(F*s2/(1.0 + F*s2), 0.0, 1.0);
}

void main(){
  vec2 fc  = gl_FragCoord.xy;
  vec2 uv  = (fc - 0.5*uRes)/uRes.y;
  vec2 suv = fc/uRes;
  vec3 rd  = normalize(uRight*uv.x + uUp*uv.y + uFwd*uFocal);

  vec3  Cc = uBPos[vIdx].xyz;
  float Rr = uBPos[vIdx].w;
  vec3  Sc = uBScale[vIdx].xyz*Rr;          /* 楕円体の半軸 */
  vec4  Pm = uBParam[vIdx];

  /* レイ-楕円体の解析交差（ローカル空間で単位球に落とす） */
  vec3  ro = (uCamPos - Cc)/Sc;
  vec3  rl = rd/Sc;
  float A  = dot(rl,rl);
  float B  = dot(ro,rl);
  float Cq = dot(ro,ro) - 1.0;
  float g  = (B*B - A*Cq)/A;                /* >0 でシルエット内部 */

  /* 導関数は分岐の外で取る（アナリティック AA） */
  float w   = max(fwidth(g), 1e-7);
  float cov = smoothstep(-w*0.75, w*0.75, g)*uBScale[vIdx].w;

  if(cov <= 0.0025){
    fragColor = (uPass==0) ? vec4(1.0) : vec4(0.0);
    return;
  }

  float sq = sqrt(max(g,0.0)*A);
  float t0 = (-B - sq)/A;
  float t1 = (-B + sq)/A;
  if(t1 <= 0.0){
    fragColor = (uPass==0) ? vec4(1.0) : vec4(0.0);
    return;
  }
  t0 = max(t0, 0.0);

  vec3 pl0 = ro + t0*rl;                    /* 手前側（ローカル単位球上） */
  vec3 pl1 = ro + t1*rl;                    /* 奥側 */
  vec3 n   = normalize(pl0/Sc);             /* 楕円体の外向き法線 */
  vec3 nb  = normalize(pl1/Sc);

  float cosT = clamp(dot(n, -rd), 0.0, 1.0);

  /* 膜厚：重力で «上が薄く下が厚い»（実際のシャボン玉の排水）＋渦ノイズ */
  float drain = 0.42 + 0.95*(0.5 - 0.5*pl0.y);
  float th = Pm.x*drain
           + 150.0*fbm2(pl0*2.6 + vec3(Pm.y, -uTime*0.06, Pm.y*0.7))
           +  60.0*fbm2(pl0*7.4 + vec3(0.0, uTime*0.04, Pm.y));
  vec3 R = filmR(cosT, th, uFilmBoost*Pm.z);

  /* ---- pass 0: 透過率（波長ごと）。ここで «反射の補色» が背景に乗る ---- */
  if(uPass == 0){
    vec3 T = clamp(1.0 - R, 0.0, 1.0);
    /* 縁は光路が長くなるぶん、わずかに濃く */
    T *= 1.0 - 0.10*pow(1.0-cosT, 3.0);
    fragColor = vec4(mix(vec3(1.0), T, cov), 1.0);
    return;
  }

  /* ---- pass 1: 反射・ハイライト（加算） ---- */
  vec3 E = vec3(0.0);

  /* 表面反射（薄膜の色がそのまま乗る） */
  vec3 rdir = reflect(rd, n);
  vec3 refl = envC(rdir)*uReflGain + lightCores(rdir);
  E += refl*R;

  /* 裏面（内側）反射：シャボン玉に «2つ目のハイライト» が出る理由 */
  vec3 rdirB = reflect(rd, -nb);
  E += (envC(rdirB)*0.55 + lightCores(rdirB)*0.8)*R*0.38;

  /* 鏡面：表裏の二重ハイライト */
  vec3 spec = vec3(0.0);
  for(int i=0;i<3;i++){
    vec3 L = uLightDir[i];
    vec3 h = normalize(L - rd + vec3(1e-5));
    float ndh  = max(dot( n, h), 1e-4);
    float ndh2 = max(dot(-nb, h), 1e-4);
    spec += uLightCol[i]*(pow(ndh, 2000.0)*7.0 + pow(ndh, 150.0)*0.55);
    spec += uLightCol[i]*(pow(ndh2,1400.0)*2.4 + pow(ndh2, 90.0)*0.14)*0.7;
  }
  E += spec*(vec3(0.55) + 0.75*R);

  /* リムライト：imgB の «くっきりした白い輪郭» の核。
     Airy 式のおかげで R 自体がかすめ角で白飛びするので、細い線を足すだけでよい */
  float rimT  = 1.0 - cosT;
  E += (vec3(1.00,0.97,1.00)*pow(smoothstep(0.52,1.0,rimT), 3.0)*0.62
      + R*pow(rimT, 4.0)*1.10) * uRimGain;

  /* 膜表面のキラキラ */
  float gl0 = pow(fbm2(pl0*24.0 + vec3(uTime*0.05, 0.0, Pm.y)), 14.0)*11.0;
  E += gl0*mix(vec3(1.0), R*2.2, 0.55)*Pm.w*uGlitter;

  /* フチのレンズ効果：final = bg*T + E なので、E に (bgOff-bg)*T を足すと
     乗算パスを壊さずに «背景がフチで引っぱられる» 挙動を再現できる */
  if(uLensWarp > 0.0){
    float zc     = max(dot(Cc - uCamPos, uFwd), 0.05);
    float screenR = clamp(Rr*uFocal/zc, 0.0, 0.6);   /* 画面上の見かけ半径 */
    vec2 nsc = vec2(dot(n,uRight), dot(n,uUp));
    vec2 off = nsc*pow(rimT, 3.0)*uLensWarp*screenR*0.38;
    vec3 bg0 = textureLod(uBG, suv, 0.0).rgb;
    vec3 bg1 = textureLod(uBG, clamp(suv + off, vec2(0.001), vec2(0.999)), 0.0).rgb;
    /* uBG は既に SSCALE 済みなので、最後の *SSCALE と二重に掛からないよう戻す */
    E += (bg1 - bg0)*SSINV*clamp(1.0 - R, 0.0, 1.0);
  }

  fragColor = vec4(max(E, vec3(0.0))*cov*SSCALE, 1.0);
}`;

/* ---------- コピー（背景 → シーン） ---------- */
const FS_COPY = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes;
out vec4 fragColor;
void main(){ fragColor = vec4(texture(uTex, gl_FragCoord.xy/uRes).rgb, 1.0); }`;

/* ---------- ブルーム ---------- */
const FS_DOWN = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes, uTexel;
uniform float uFirst, uThreshold, uKnee;
out vec4 fragColor;
vec3 T(vec2 o){ return texture(uTex, (gl_FragCoord.xy/uRes) + o*uTexel).rgb; }
void main(){
  vec3 a=T(vec2(-2.0,2.0)), b=T(vec2(0.0,2.0)), c=T(vec2(2.0,2.0));
  vec3 d=T(vec2(-2.0,0.0)), e=T(vec2(0.0,0.0)), f=T(vec2(2.0,0.0));
  vec3 g=T(vec2(-2.0,-2.0)), h=T(vec2(0.0,-2.0)), i=T(vec2(2.0,-2.0));
  vec3 j=T(vec2(-1.0,1.0)), k=T(vec2(1.0,1.0)), l=T(vec2(-1.0,-1.0)), m=T(vec2(1.0,-1.0));
  vec3 col = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
  if(uFirst > 0.5){
    float br = max(col.r, max(col.g,col.b));
    float kn = max(uThreshold*uKnee, 1e-4);
    float soft = clamp(br-uThreshold+kn, 0.0, 2.0*kn);
    soft = soft*soft/(4.0*kn);
    col *= max(soft, br-uThreshold)/max(br,1e-4);
  }
  fragColor = vec4(col, 1.0);
}`;

/* v2 は上げ合成で等倍加算していたので広いミップまで効き、画面全体が靄った。
   uGain(<1) を掛けることで «細いグロー» に寄せる。 */
const FS_UP = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes, uTexel;
uniform float uAniso, uGain;
out vec4 fragColor;
vec3 T(vec2 o){ return texture(uTex, (gl_FragCoord.xy/uRes) + o*vec2(uTexel.x*uAniso, uTexel.y)).rgb; }
void main(){
  vec3 s = T(vec2(-1.0,1.0)) + T(vec2(0.0,1.0))*2.0 + T(vec2(1.0,1.0))
         + T(vec2(-1.0,0.0))*2.0 + T(vec2(0.0,0.0))*4.0 + T(vec2(1.0,0.0))*2.0
         + T(vec2(-1.0,-1.0)) + T(vec2(0.0,-1.0))*2.0 + T(vec2(1.0,-1.0));
  fragColor = vec4(s/16.0*uGain, 1.0);
}`;

/* 十字ストリーク（星形の光条）。imgB のキラッとした輝きの正体。 */
const FS_STREAK = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes, uTexel;
uniform vec2 uDir;
uniform float uAtten;
out vec4 fragColor;
void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 st = uDir*uTexel;
  vec3 s = texture(uTex, uv).rgb;
  float wsum = 1.0, a = 1.0;
  for(int i=1;i<=9;i++){
    a *= uAtten;
    float fi = float(i)*1.35;
    s += (texture(uTex, uv + st*fi).rgb + texture(uTex, uv - st*fi).rgb)*a;
    wsum += 2.0*a;
  }
  fragColor = vec4(s/wsum, 1.0);
}`;

const FS_COMPOSITE = HEAD + GRADE + `
uniform sampler2D uScene, uBloom, uStreak;
uniform vec2 uRes;
uniform float uTime, uBloomStr, uStreakStr, uVignette, uGrain;
out vec4 fragColor;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 dd = uv-0.5;
  float r2 = dot(dd,dd);
  vec3 col = texture(uScene,  uv).rgb*SSINV;
  col += texture(uBloom,  uv).rgb*SSINV*uBloomStr;
  col += texture(uStreak, uv).rgb*SSINV*uStreakStr;
  col = grade(col);
  col *= 1.0 - uVignette*smoothstep(0.10, 1.05, r2*1.35);
  col += (hash(gl_FragCoord.xy + fract(uTime)*137.0) - 0.5)*uGrain;
  fragColor = vec4(clamp(col,0.0,1.0), 1.0);
}`;

/* ---------- サイバー線（グロー付きリボン + 信号パケット） ---------- */
const VLIB = `float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }`;

const VS_LINE = HEAD + VLIB + `
uniform vec3 uCamPos2, uRight2, uUp2, uFwd2;
uniform float uFocal2, uAspect, uTime, uSegs, uWidth;
out vec3 vCol;
out float vA;
vec3 curvePoint(float id, float u, float t){
  float s = hash11(id*1.7+0.3)*20.0;
  float spin = t*(0.018+0.03*hash11(id+7.3))+s;
  float R = 1.6+2.9*hash11(id+2.1);
  float yspan = 3.2+2.2*hash11(id+5.5);
  float turns = 1.1+2.4*hash11(id+9.9);
  float ang = u*TAU*turns + spin;
  float rr = R*(0.62+0.48*sin(u*4.7+s));
  vec3 p = vec3(cos(ang)*rr, (u-0.5)*yspan+0.5*sin(u*5.0+s), sin(ang)*rr);
  p += 0.4*vec3(sin(u*9.0+t*0.3+s), sin(u*7.0-t*0.25+s*1.7), sin(u*8.0+t*0.27+s*0.3));
  return p;
}
vec2 proj(vec3 P, out float depth){
  vec3 v = P - uCamPos2;
  float a = dot(v,uRight2), b = dot(v,uUp2), c = max(dot(v,uFwd2), 0.3);
  depth = c;
  return vec2(2.0*uFocal2*a/(uAspect*c), 2.0*uFocal2*b/c);
}
void main(){
  int vid = gl_VertexID;
  int seg = vid/6;
  int corner = vid - seg*6;
  float cid = floor(float(seg)/uSegs);
  float sid = float(seg) - cid*uSegs;
  float e = (corner==1||corner==4||corner==5) ? 1.0 : 0.0;
  float side = (corner==0||corner==1||corner==4) ? -1.0 : 1.0;
  float u0 = sid/uSegs, u1 = (sid+1.0)/uSegs;
  float d0, d1;
  vec2 s0 = proj(curvePoint(cid,u0,uTime), d0);
  vec2 s1 = proj(curvePoint(cid,u1,uTime), d1);
  vec2 dir = s1 - s0; dir.x *= uAspect;
  float L = length(dir);
  dir = (L>1e-5) ? dir/L : vec2(1.0,0.0);
  vec2 nrm = vec2(-dir.y, dir.x); nrm.x /= uAspect;
  float u = mix(u0,u1,e);
  vec2 s = mix(s0,s1,e);
  float dep = mix(d0,d1,e);
  gl_Position = vec4(s + nrm*(uWidth/dep)*side, 0.0, 1.0);
  vA = side;

  float ph = fract(u*0.85 - uTime*0.05 + hash11(cid+3.3));
  float packet = exp(-ph*16.0) + exp(-fract(ph+0.5)*26.0)*0.45;
  float ends = smoothstep(0.0,0.14,u)*smoothstep(1.0,0.86,u);
  float hh = hash11(cid+4.4);
  vec3 base = (hh<0.22) ? vec3(0.62,0.96,1.00) : (hh<0.60) ? vec3(1.00,0.72,0.95) : vec3(0.86,0.74,1.00);
  float near = smoothstep(0.3, 1.2, dep);
  vCol = base*(0.16+2.8*packet)*ends*near*(0.55+0.45*sin(uTime*0.35+cid*3.0));
}`;
const FS_LINE = HEAD + `
in vec3 vCol;
in float vA;
out vec4 fragColor;
void main(){
  float a2 = vA*vA;
  float core = exp(-a2*55.0);
  float glow = exp(-a2*4.5)*0.20;
  fragColor = vec4(vCol*(core+glow)*SSCALE, 0.0);
}`;

/* ---------- 塵・スパークル ---------- */
const VS_PT = HEAD + VLIB + `
uniform vec3 uCamPos2, uRight2, uUp2, uFwd2;
uniform float uFocal2, uAspect, uTime, uPxScale;
out vec3 vCol;
out float vSoft;
out float vStar;
void main(){
  float id = float(gl_VertexID);
  float h1 = hash11(id*1.13+0.7);
  float h2 = hash11(id*2.31+3.1);
  float h3 = hash11(id*3.77+9.4);
  float h4 = hash11(id*5.19+5.5);
  float rad = 0.9+5.4*h1;
  float ang = h2*TAU + uTime*(0.02+0.03*h4);
  float yy = mod(h3*8.0 + uTime*(0.02+0.04*h2), 8.0) - 4.0;
  vec3 P = vec3(cos(ang)*rad, yy, sin(ang)*rad);
  P += 0.6*vec3(sin(uTime*0.35+h1*30.0), sin(uTime*0.27+h2*22.0), sin(uTime*0.31+h3*17.0));
  vec3 v = P - uCamPos2;
  float a = dot(v,uRight2), b = dot(v,uUp2), c = dot(v,uFwd2);
  gl_Position = vec4(2.0*uFocal2*a/uAspect, 2.0*uFocal2*b, 0.0, max(c,0.001));
  float defocus = clamp(abs(c-4.4)/4.0, 0.0, 1.0);
  gl_PointSize = clamp(uPxScale*(0.4+1.4*h4)*(0.5+2.5*defocus)/max(c,0.15), 1.5, 44.0);
  vSoft = defocus;
  vStar = step(0.68, h3)*(1.0-defocus);          /* 手前の粒だけ星形に光らせる */
  float tw = pow(0.5+0.5*sin(uTime*0.45+h1*60.0), 3.0);
  vec3 base = (h2<0.40) ? vec3(1.00,0.86,0.95) : (h2<0.62) ? vec3(0.76,0.95,1.00)
            : (h2<0.82) ? vec3(0.90,0.82,1.00) : vec3(1.00,0.92,0.80);
  vCol = base*(0.18+1.7*tw)*(0.35+0.65*h1)*mix(1.0,0.35,defocus)*step(0.3,c);
}`;
const FS_PT = HEAD + `
in vec3 vCol;
in float vSoft;
in float vStar;
out vec4 fragColor;
void main(){
  vec2 q = gl_PointCoord-0.5;
  float r2 = dot(q,q)*4.0;
  if(r2>1.0 && vStar<0.5) discard;
  float disc = smoothstep(1.0, 0.72, r2)*(0.6+0.6*smoothstep(0.45,1.0,r2));
  float soft = exp(-r2*3.2)*(1.0-clamp(r2,0.0,1.0)*clamp(r2,0.0,1.0));
  float base = mix(soft, disc, vSoft);
  /* 十字の輝き */
  float sx = exp(-abs(q.x)*120.0)*exp(-abs(q.y)*9.0);
  float sy = exp(-abs(q.y)*120.0)*exp(-abs(q.x)*9.0);
  float star = (sx+sy)*1.6*vStar;
  fragColor = vec4(vCol*(base + star)*SSCALE, 0.0);
}`;

progEnv       = link(VS_QUAD,   FS_ENV,       'env');
progBG        = link(VS_QUAD,   FS_BG,        'bg');
progBubble    = link(VS_BUBBLE, FS_BUBBLE,    'bubble');
progCopy      = link(VS_QUAD,   FS_COPY,      'copy');
progDown      = link(VS_QUAD,   FS_DOWN,      'down');
progUp        = link(VS_QUAD,   FS_UP,        'up');
progStreak    = link(VS_QUAD,   FS_STREAK,    'streak');
progComposite = link(VS_QUAD,   FS_COMPOSITE, 'composite');
progLine      = link(VS_LINE,   FS_LINE,      'line');
progDust      = link(VS_PT,     FS_PT,        'dust');
}catch(e){
  buildOK = false;
  console.error('[bubble-bg] shader build failed: ' + e.message);
}
if(!buildOK) return;

/* ============================================================
   5. レンダーターゲット
   ============================================================ */
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
function drawQuad(){ gl.drawArrays(gl.TRIANGLES, 0, 3); }

const rtEnv = makeRT(ENV_W, ENV_H, HDR);
gl.bindTexture(gl.TEXTURE_2D, rtEnv.tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);  /* 経度方向の継ぎ目対策 */

let W=0, H=0, rtScene=null, rtBG=null, rtStreak=null, rtBloom=[];
function buildTargets(w, h){
  freeRT(rtScene); freeRT(rtBG); freeRT(rtStreak); rtBloom.forEach(freeRT);
  W=w; H=h;
  rtScene = makeRT(w, h, HDR);
  rtBG    = makeRT(w, h, HDR);
  rtBloom = [];
  let bw = Math.max(4, w>>1), bh = Math.max(4, h>>1);
  for(let i=0;i<4;i++){
    rtBloom.push(makeRT(bw, bh, HDR));
    bw = Math.max(4, bw>>1); bh = Math.max(4, bh>>1);
  }
  rtStreak = makeRT(Math.max(4, w>>2), Math.max(4, h>>2), HDR);
}

/* ============================================================
   6. シャボン玉（解析的楕円体・物理は CPU 側で軽く）
   ============================================================ */
let bub = [];
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TAU_J = Math.PI*2;

/* imgB のように «巨大な近景玉／中景／細かくシャープな小玉» を混在させる。
   v2 は半径 0.32〜0.87 が原点付近に密集して1つの塊に融合していた。 */
function initBubbles(n, seed){
  const rnd = (seed===undefined || seed===null) ? Math.random : mulberry32(seed);
  bub = [];
  for(let i=0;i<n;i++){
    const u = rnd();
    let r;
    if(u < 0.13)      r = 0.85 + rnd()*1.00;   /* 巨大（画面を大きく覆う） */
    else if(u < 0.46) r = 0.32 + rnd()*0.44;   /* 中 */
    else              r = 0.09 + rnd()*0.19;   /* 小（粒立ちを作る） */

    const th  = rnd()*TAU_J, ph = Math.acos(2*rnd()-1);
    const rad = 0.8 + Math.pow(rnd(), 0.62)*4.6;
    bub.push({
      x: rad*Math.sin(ph)*Math.cos(th),
      y: rad*Math.cos(ph)*0.75,
      z: rad*Math.sin(ph)*Math.sin(th),
      vx:(rnd()-0.5)*0.16, vy:(rnd()-0.5)*0.10, vz:(rnd()-0.5)*0.16,
      r: r,
      seed: rnd()*100,
      /* 膜厚基準：小さい玉ほど薄く（＝淡く白っぽく）、大きい玉ほど高次の縞 */
      film: LOOK.filmMin + (LOOK.filmMax-LOOK.filmMin)*(0.25 + 0.75*rnd()) * (0.75 + 0.5*Math.min(r,1.2)),
      boost: 0.72 + rnd()*0.62,
      glit:  0.35 + rnd()*0.95,
      /* 非球形の «ゆれ» 用位相 */
      p1: rnd()*TAU_J, p2: rnd()*TAU_J, p3: rnd()*TAU_J,
      s1: 0.16+rnd()*0.22, s2: 0.14+rnd()*0.20, s3: 0.15+rnd()*0.21
    });
  }
}
function stepBubbles(dt, t){
  const BOUND = 5.8;
  for(let i=0;i<bub.length;i++){
    const b = bub[i];
    /* ふわふわ：小さい玉ほど速く漂い、大きい玉はゆっくり */
    const m = 1.0/(0.35 + b.r);
    b.vx += Math.sin(b.y*0.55 + t*0.17 + b.seed)*0.010*m*dt;
    b.vy += (Math.sin(b.z*0.55 + t*0.15 + b.seed*1.3)*0.010 + 0.016)*m*dt;   /* 浮力 */
    b.vz += Math.sin(b.x*0.55 + t*0.13 + b.seed*0.7)*0.010*m*dt;
    b.vx *= 0.993; b.vy *= 0.993; b.vz *= 0.993;
    b.x += b.vx*dt; b.y += b.vy*dt; b.z += b.vz*dt;

    /* 上へ抜けたら下から戻す（ゆっくり循環する感じ） */
    if(b.y > 4.6){ b.y = -4.6; b.vy *= 0.5; }
    const d = Math.hypot(b.x, b.z);
    const maxD = BOUND - b.r*0.5;
    if(d > maxD && d > 1e-5){
      const nx=b.x/d, nz=b.z/d;
      b.x = nx*maxD; b.z = nz*maxD;
      const vn = b.vx*nx + b.vz*nz;
      b.vx -= 1.8*vn*nx; b.vz -= 1.8*vn*nz;
      b.vx *= 0.7; b.vz *= 0.7;
    }
  }
}

/* ============================================================
   7. カメラ・パラメータ
   ============================================================ */
let yaw = 0.5, pitch = 0.18, dist = 4.6;
let autoYaw = 0;
const params = { spin: 1.0 };
const toggles = { rotate: true, paused: false };

const FIXED_SEED = (typeof window.BG_FIXED_SEED === 'number') ? window.BG_FIXED_SEED : 20260901;
initBubbles(MAXB, FIXED_SEED);

/* ============================================================
   8. リサイズ + 適応解像度スケーラ
   ============================================================ */
/* 初回は少し控えめに始め、実測が速ければ適応スケーラが上限まで引き上げる
   （弱い端末で最初の数秒がカクつくのを防ぐため） */
let qScale = 0.80;
function resize(){
  const cw = Math.max(1, Math.floor(window.innerWidth));
  const ch = Math.max(1, Math.floor(window.innerHeight));
  canvas.style.width = cw+'px'; canvas.style.height = ch+'px';
  const dpr = Math.min(window.devicePixelRatio||1, RES.DPR_MAX);
  /* まず «上限いっぱいの理想サイズ» を決め、そのあとに適応スケールを掛ける */
  let bw = Math.max(1, Math.round(cw*dpr));
  let bh = Math.max(1, Math.round(ch*dpr));
  const shortSide = Math.min(bw,bh);
  if(shortSide > RES.SHORT_SIDE_MAX){
    const s = RES.SHORT_SIDE_MAX/shortSide;
    bw = Math.round(bw*s); bh = Math.round(bh*s);
  }
  bw = Math.round(bw*qScale); bh = Math.round(bh*qScale);
  if(Math.min(bw,bh) < RES.SHORT_SIDE_MIN){
    const s = RES.SHORT_SIDE_MIN/Math.max(1, Math.min(bw,bh));
    bw = Math.round(bw*s); bh = Math.round(bh*s);
  }
  bw = Math.max(1,bw); bh = Math.max(1,bh);
  if(canvas.width === bw && canvas.height === bh && rtScene) return;
  canvas.width = bw; canvas.height = bh;
  buildTargets(bw, bh);   /* v2 は 0.75 倍で描いてから拡大していた。v3 は等倍。 */
}
window.addEventListener('resize', resize);

/* 実測フレーム時間で解像度を自動増減（重い端末では勝手に軽く、速い端末では上限まで） */
let emaMs = 16.0, adaptCool = 0, fpsShow = 60;
function adapt(dtMs){
  emaMs = emaMs*0.94 + dtMs*0.06;
  fpsShow = 1000/Math.max(emaMs, 1e-3);
  if(adaptCool > 0){ adaptCool--; return; }
  if(emaMs > 23.0 && qScale > RES.SCALE_MIN){
    qScale = Math.max(RES.SCALE_MIN, qScale*0.86);
    adaptCool = 90; resize();
  }else if(emaMs < 12.0 && qScale < RES.SCALE_MAX){
    qScale = Math.min(RES.SCALE_MAX, qScale*1.07);
    adaptCool = 150; resize();
  }
}

/* ============================================================
   9. メインループ
   ============================================================ */
let simTime = 0, prevTs = performance.now();
let renderTick = 0, raf = 0;
const SEGS = 40, LINE_CURVES = 8, LINE_VERTS = LINE_CURVES*SEGS*6, PT_COUNT = 260;

const arrPos   = new Float32Array(MAXB*4);
const arrScale = new Float32Array(MAXB*4);
const arrParam = new Float32Array(MAXB*4);

const lightDir = new Float32Array(9);
const lightCol = new Float32Array([
  1.00, 0.90, 0.97,   /* 前方の «太陽»: 桜白 */
  0.96, 0.90, 1.00,   /* カメラ側キーライト: 藤白 */
  0.80, 0.95, 1.00    /* 世界固定: 空色（サブ） */
]);
function setLight(i, x,y,z){
  const l = Math.hypot(x,y,z)||1;
  lightDir[i*3]=x/l; lightDir[i*3+1]=y/l; lightDir[i*3+2]=z/l;
}
function setCam(P, px,py,pz, rx,ry,rz, ux,uy,uz, fx,fy,fz, FOCAL, aspect){
  gl.uniform3f(P.u.uCamPos2, px,py,pz);
  gl.uniform3f(P.u.uRight2, rx,ry,rz);
  gl.uniform3f(P.u.uUp2, ux,uy,uz);
  gl.uniform3f(P.u.uFwd2, fx,fy,fz);
  gl.uniform1f(P.u.uFocal2, FOCAL);
  gl.uniform1f(P.u.uAspect, aspect);
  gl.uniform1f(P.u.uTime, simTime);
}

function renderPass(dt){
  if(toggles.rotate) autoYaw += dt*0.0022*params.spin;
  const cy = yaw+autoYaw, cp = pitch + 0.03*Math.sin(simTime*0.05);
  const px = Math.sin(cy)*Math.cos(cp)*dist, py = Math.sin(cp)*dist, pz = Math.cos(cy)*Math.cos(cp)*dist;
  const fx=-px/dist, fy=-py/dist, fz=-pz/dist;
  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx,ry,rz)||1; rx/=rl; ry/=rl; rz/=rl;
  const ux = ry*fz-rz*fy, uy = rz*fx-rx*fz, uz = rx*fy-ry*fx;
  const FOCAL = 1.55;
  const aspect = W/H;

  setLight(0, -0.45*rx+0.40*ux+0.80*fx, -0.45*ry+0.40*uy+0.80*fy, -0.45*rz+0.40*uz+0.80*fz);
  setLight(1,  0.50*rx+0.60*ux-0.62*fx,  0.50*ry+0.60*uy-0.62*fy,  0.50*rz+0.60*uz-0.62*fz);
  setLight(2, 0.6, 0.3, 0.7);

  stepBubbles(dt, simTime);

  /* --- 描画する玉を詰める（カメラ背後・内側に入り込んだものは除外） --- */
  const maxCount = Math.min(LOOK.count|0, MAXB, bub.length);
  let nDraw = 0;
  for(let i=0;i<bub.length && nDraw<maxCount;i++){
    const b = bub[i];
    const s1 = 1.0 + 0.075*Math.sin(simTime*b.s1 + b.p1);
    const s2 = 1.0 + 0.075*Math.sin(simTime*b.s2 + b.p2);
    const s3 = 1.0 + 0.075*Math.sin(simTime*b.s3 + b.p3);
    const rmax = b.r*Math.max(s1, Math.max(s2, s3));
    const zc = (b.x-px)*fx + (b.y-py)*fy + (b.z-pz)*fz;
    if(zc < rmax*1.20) continue;                 /* カメラが玉の中／背後 */
    /* カメラのすぐ手前を通り抜ける玉がパッと消えないようフェードさせる */
    const fade = Math.min(1, Math.max(0, (zc - rmax*1.25)/(rmax*1.10)));
    if(fade <= 0.004) continue;
    const k = nDraw*4;
    arrPos[k]=b.x; arrPos[k+1]=b.y; arrPos[k+2]=b.z; arrPos[k+3]=b.r;
    arrScale[k]=s1; arrScale[k+1]=s2; arrScale[k+2]=s3; arrScale[k+3]=fade*fade*(3-2*fade);
    arrParam[k]=b.film; arrParam[k+1]=b.seed; arrParam[k+2]=b.boost; arrParam[k+3]=b.glit;
    nDraw++;
  }
  for(let i=nDraw;i<MAXB;i++){
    const k=i*4;
    arrPos[k]=arrPos[k+1]=arrPos[k+2]=0; arrPos[k+3]=1;   /* 0除算予防（描画対象外） */
    arrScale[k]=arrScale[k+1]=arrScale[k+2]=1; arrScale[k+3]=0;   /* fade=0 ＝ 無効 */
    arrParam[k]=300; arrParam[k+1]=0; arrParam[k+2]=1; arrParam[k+3]=0;
  }

  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);

  /* ---- pass 0: 環境マップ（映り込み専用）。2 フレームに 1 回で十分 ---- */
  if((renderTick & 1) === 0){
    const P = progEnv;
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtEnv.fb);
    gl.viewport(0,0,ENV_W,ENV_H);
    gl.uniform2f(P.u.uEnvRes, ENV_W, ENV_H);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform1f(P.u.uHueBias, LOOK.hueBias);
    gl.uniform1f(P.u.uSilkWhite, LOOK.silkWhite);
    gl.uniform3fv(P.u.uLightDir, lightDir);
    gl.uniform3fv(P.u.uLightCol, lightCol);
    drawQuad();
  }

  /* ---- pass 1: 背景（画面空間・等倍）→ rtBG ---- */
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtBG.fb);
  gl.viewport(0,0,W,H);
  {
    const P = progBG;
    gl.useProgram(P.p);
    gl.uniform2f(P.u.uRes, W, H);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform3f(P.u.uCamPos, px,py,pz);
    gl.uniform3f(P.u.uRight, rx,ry,rz);
    gl.uniform3f(P.u.uUp, ux,uy,uz);
    gl.uniform3f(P.u.uFwd, fx,fy,fz);
    gl.uniform1f(P.u.uFocal, FOCAL);
    gl.uniform1f(P.u.uHueBias, LOOK.hueBias);
    gl.uniform1f(P.u.uVeins, LOOK.veins);
    gl.uniform1f(P.u.uFlare, LOOK.flare);
    gl.uniform1f(P.u.uSilkWhite, LOOK.silkWhite);
    gl.uniform3fv(P.u.uLightDir, lightDir);
    gl.uniform3fv(P.u.uLightCol, lightCol);
    drawQuad();
  }

  /* ---- pass 1b: サイバー線を背景に加算（玉の透過率が後で乗る） ---- */
  if(LOOK.lines){
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const P = progLine;
    gl.useProgram(P.p);
    setCam(P, px,py,pz, rx,ry,rz, ux,uy,uz, fx,fy,fz, FOCAL, aspect);
    gl.uniform1f(P.u.uSegs, SEGS);
    gl.uniform1f(P.u.uWidth, 0.060);
    gl.drawArrays(gl.TRIANGLES, 0, LINE_VERTS);
    gl.disable(gl.BLEND);
  }

  /* ---- pass 2: rtBG → rtScene へコピー ---- */
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtScene.fb);
  gl.viewport(0,0,W,H);
  {
    const P = progCopy;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtBG.tex);
    gl.uniform1i(P.u.uTex, 0);
    gl.uniform2f(P.u.uRes, W, H);
    drawQuad();
  }

  /* ---- pass 3: シャボン玉（乗算 → 加算の 2 パス。どちらも順序非依存） ---- */
  if(nDraw > 0){
    const P = progBubble;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtEnv.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rtBG.tex);
    gl.uniform1i(P.u.uEnv, 0);
    gl.uniform1i(P.u.uBG, 1);
    gl.uniform2f(P.u.uRes, W, H);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform3f(P.u.uCamPos, px,py,pz);
    gl.uniform3f(P.u.uRight, rx,ry,rz);
    gl.uniform3f(P.u.uUp, ux,uy,uz);
    gl.uniform3f(P.u.uFwd, fx,fy,fz);
    gl.uniform1f(P.u.uFocal, FOCAL);
    gl.uniform1f(P.u.uAspect, aspect);
    gl.uniform1f(P.u.uHueBias, LOOK.hueBias);
    gl.uniform1f(P.u.uFilmBoost, LOOK.filmBoost);
    gl.uniform1f(P.u.uReflGain, LOOK.reflGain);
    gl.uniform1f(P.u.uRimGain, LOOK.rimGain);
    gl.uniform1f(P.u.uGlitter, LOOK.glitter);
    gl.uniform1f(P.u.uLensWarp, LOOK.lensWarp);
    gl.uniform4fv(P.u.uBPos, arrPos);
    gl.uniform4fv(P.u.uBScale, arrScale);
    gl.uniform4fv(P.u.uBParam, arrParam);
    gl.uniform3fv(P.u.uLightDir, lightDir);
    gl.uniform3fv(P.u.uLightCol, lightCol);

    gl.enable(gl.BLEND);
    /* A: 透過率を乗算（dst = dst * src）。波長ごとなので補色が正しく出る */
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
    gl.uniform1i(P.u.uPass, 0);
    gl.drawArrays(gl.TRIANGLES, 0, nDraw*6);
    /* B: 反射・ハイライトを加算 */
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1i(P.u.uPass, 1);
    gl.drawArrays(gl.TRIANGLES, 0, nDraw*6);
    gl.disable(gl.BLEND);
  }

  /* ---- pass 4: 塵・スパークルを前景に加算 ---- */
  if(LOOK.dust){
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const P = progDust;
    gl.useProgram(P.p);
    setCam(P, px,py,pz, rx,ry,rz, ux,uy,uz, fx,fy,fz, FOCAL, aspect);
    gl.uniform1f(P.u.uPxScale, H*0.013);
    gl.drawArrays(gl.POINTS, 0, PT_COUNT);
    gl.disable(gl.BLEND);
  }

  /* ---- pass 5: ブルーム（v2 より締める） ---- */
  gl.useProgram(progDown.p);
  gl.uniform1i(progDown.u.uTex, 0);
  gl.uniform1f(progDown.u.uThreshold, 1.05*SS);
  gl.uniform1f(progDown.u.uKnee, 0.55);
  gl.activeTexture(gl.TEXTURE0);
  for(let i=0;i<rtBloom.length;i++){
    const src = (i===0) ? rtScene : rtBloom[i-1], dst = rtBloom[i];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0,0,dst.w,dst.h);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(progDown.u.uRes, dst.w, dst.h);
    gl.uniform2f(progDown.u.uTexel, 1/src.w, 1/src.h);
    gl.uniform1f(progDown.u.uFirst, i===0 ? 1.0 : 0.0);
    drawQuad();
  }
  gl.useProgram(progUp.p);
  gl.uniform1i(progUp.u.uTex, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  for(let i=rtBloom.length-1;i>0;i--){
    const src = rtBloom[i], dst = rtBloom[i-1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0,0,dst.w,dst.h);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(progUp.u.uRes, dst.w, dst.h);
    gl.uniform2f(progUp.u.uTexel, 1/src.w, 1/src.h);
    gl.uniform1f(progUp.u.uAniso, 1.0 + 1.2*(i/rtBloom.length));
    gl.uniform1f(progUp.u.uGain, 0.62);   /* ← 靄らせない鍵 */
    drawQuad();
  }
  gl.disable(gl.BLEND);

  /* ---- pass 6: 十字ストリーク（星形の光条） ---- */
  {
    const P = progStreak;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    /* 横方向 → rtStreak */
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtStreak.fb);
    gl.viewport(0,0,rtStreak.w,rtStreak.h);
    gl.bindTexture(gl.TEXTURE_2D, rtBloom[1].tex);
    gl.uniform2f(P.u.uRes, rtStreak.w, rtStreak.h);
    gl.uniform2f(P.u.uTexel, 1/rtBloom[1].w, 1/rtBloom[1].h);
    gl.uniform2f(P.u.uDir, 1.0, 0.0);
    gl.uniform1f(P.u.uAtten, 0.80);
    drawQuad();
    /* 縦方向を加算 */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindTexture(gl.TEXTURE_2D, rtBloom[1].tex);
    gl.uniform2f(P.u.uDir, 0.0, 1.0);
    gl.uniform1f(P.u.uAtten, 0.76);
    drawQuad();
    gl.disable(gl.BLEND);
  }

  /* ---- pass 7: 合成 → canvas ---- */
  {
    const P = progComposite;
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rtBloom[0].tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, rtStreak.tex);
    gl.uniform1i(P.u.uScene, 0);
    gl.uniform1i(P.u.uBloom, 1);
    gl.uniform1i(P.u.uStreak, 2);
    gl.uniform2f(P.u.uRes, canvas.width, canvas.height);
    gl.uniform1f(P.u.uTime, simTime);
    gl.uniform1f(P.u.uBloomStr, LOOK.bloom);
    gl.uniform1f(P.u.uStreakStr, LOOK.streak);
    gl.uniform1f(P.u.uVignette, LOOK.vignette);
    gl.uniform1f(P.u.uGrain, LOOK.grain);
    gl.uniform1f(P.u.uExposure, LOOK.exposure);
    gl.uniform1f(P.u.uContrast, LOOK.contrast);
    gl.uniform1f(P.u.uSat, LOOK.saturation);
    gl.uniform1f(P.u.uPreSat, LOOK.preSat);
    gl.uniform1f(P.u.uLift, LOOK.lift);
    drawQuad();
  }

  renderTick++;
  window.BubbleBG.tick = renderTick;
  if(!window.BubbleBG.ready) window.BubbleBG.ready = true;
}

function frame(ts){
  raf = requestAnimationFrame(frame);
  const rawMs = ts - prevTs;
  let dt = Math.min(0.05, rawMs/1000); prevTs = ts;
  if(toggles.paused) dt = 0;
  simTime += dt;
  renderPass(dt);
  if(renderTick > 20) adapt(Math.min(rawMs, 100));
}

/* ============================================================
   10. 起動 / 表示状態に応じた一時停止
   ============================================================ */
function startLoop(){ if(!raf){ prevTs = performance.now(); raf = requestAnimationFrame(frame); } }
function stopLoop(){ if(raf){ cancelAnimationFrame(raf); raf = 0; } }
document.addEventListener('visibilitychange', function(){
  if(document.hidden) stopLoop(); else startLoop();
});

/* チューニング用の外部インターフェース（任意） */
window.BubbleBG.look = LOOK;
window.BubbleBG.setLook = function(o){ if(o) for(const k in o){ if(k in LOOK) LOOK[k] = o[k]; } };
window.BubbleBG.stats = function(){
  return { fps: Math.round(fpsShow), w: W, h: H, scale: +qScale.toFixed(3), hdr: HDR, bubbles: LOOK.count };
};

resize();
startLoop();

} /* end boot() */

if('requestIdleCallback' in window){
  requestAnimationFrame(function(){ requestIdleCallback(boot, {timeout: 300}); });
}else{
  requestAnimationFrame(function(){ requestAnimationFrame(boot); });
}

})();