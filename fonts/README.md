# ローカルフォント配置ガイド

このディレクトリ (`static/fonts/`) は、Dream Voice GUI が完全オフラインで動作するように Web フォントをローカル配置するための場所です。

## 現在配置されているフォント

Google Fonts 公式リポジトリより取得した正規のフォントファイルが配置されており、**このまますぐにオフラインで使用可能**です。

| フォントファミリー | ファイル名 | ウェイト | 説明 |
| :--- | :--- | :--- | :--- |
| **Zen Kaku Gothic New** | `ZenKakuGothicNew-Light.ttf` | 300 (Light) | 日本語フォント (細字) |
| **Zen Kaku Gothic New** | `ZenKakuGothicNew-Regular.ttf` | 400 (Regular) | 日本語フォント (標準) |
| **Zen Kaku Gothic New** | `ZenKakuGothicNew-Medium.ttf` | 500 (Medium) | 日本語フォント (中太) |
| **Zen Kaku Gothic New** | `ZenKakuGothicNew-Bold.ttf` | 700 (Bold) | 日本語フォント (太字) |
| **Zen Kaku Gothic New** | `ZenKakuGothicNew-Black.ttf` | 900 (Black) | 日本語フォント (極太) |
| **Outfit** | `Outfit[wght].ttf` | 100〜900 (可変) | 英数字フォント (可変フォント) |

---

## 独自にフォントファイルを差し替えたい場合

フォントファイルを再ダウンロードまたは別の形式（woff2 など）に差し替える場合は、以下の手順で行えます。

### 1. Google Fonts からのダウンロード
- **Zen Kaku Gothic New**: [Google Fonts - Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New)
- **Outfit**: [Google Fonts - Outfit](https://fonts.google.com/specimen/Outfit)

ZIP を解凍後、上記表のファイル名に合わせてこのディレクトリ (`static/fonts/`) に上書き配置してください。

### 2. woff2 / woff 形式を使いたい場合
`fonts.css` の `src: url(...) format(...)` 部分をお手持ちのファイル名・形式に合わせて編集してください。
```css
@font-face {
  font-family: 'Zen Kaku Gothic New';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./ZenKakuGothicNew-Regular.woff2') format('woff2');
}
```
