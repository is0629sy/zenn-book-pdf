# Zenn PDF Tool

公開されているZennの記事・本（book）のURLを指定し，その本文をPDFとして保存するCLIツールです。

対象URLは次の形式です。

```text
https://zenn.dev/<user>/articles/<slug>
https://zenn.dev/<user>/books/<slug>
https://zenn.dev/<user>/books/<slug>/viewer/<chapter-slug>
```

本のURL（`viewer` なし）を指定した場合は，全チャプターを取得して，表紙・目次付きの1つのPDFにまとめます。
`viewer/<chapter-slug>` まで指定した場合は，そのチャプター1つだけをPDF化します。

## 解説記事

このツールを作った背景と実装方針は，次のZenn記事にまとめています。

```text
https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5
```

## 事前準備

Node.js 20以上を使います。最初に依存パッケージとPlaywright用のChromiumを入れます。

```bash
npm install
npx playwright install chromium
```

## GitHubから使う

まだリポジトリを取得していない場合は，次の手順で取得します。

```bash
git clone https://github.com/is0629sy/zenn-book-pdf.git
cd zenn-book-pdf
```

その後，依存パッケージとChromiumを入れます。

```bash
npm install
npx playwright install chromium
```

## PDF化の手順

PDF化したいZenn記事のURLを，次のコマンドの末尾に入れて実行します。

```bash
npm run pdf -- https://zenn.dev/<user>/articles/<slug>
```

たとえば，このツールの解説記事をPDFとして保存する場合は，次を実行します。

```bash
npm run pdf -- https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5
```

出力先を指定しない場合，PDFは `pdfs/` に保存されます。ファイル名は，Zennのユーザー名と記事スラッグから自動で決まります。

上の例では次のPDFが作成されます。

```text
pdfs/kato_aichi_bad1d62fd7c9f5.pdf
```

出力先を指定したい場合は，URLの後ろにPDFファイルのパスを入れます。

```bash
npm run pdf -- https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5 pdfs/zenn-pdf-article.pdf
```

または，オプション形式でも指定できます。`--output` と `--out` は同じ意味です。

```bash
npm run pdf -- --url https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5 --output pdfs/zenn-pdf-article.pdf
```

```bash
npm run pdf -- --url https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5 --out pdfs/zenn-pdf-article.pdf
```

## 本（book）をPDF化する

本のトップページURL（`viewer` を含まないURL）を指定すると，全チャプターをまとめて1つのPDFにします。

```bash
npm run pdf -- https://zenn.dev/<user>/books/<slug>
```

出力先を指定しない場合，ファイル名は `pdfs/<user>_<slug>.pdf` になります。

PDFの構成は次のとおりです。

1. 表紙（本のタイトル・概要・タグ・URL）
2. 目次（チャプター一覧）
3. 各チャプター本文（チャプターごとに改ページ）

本の特定の1チャプターだけをPDF化したい場合は，`viewer/<chapter-slug>` まで含めたURLを指定します（記事と同じ扱いになります）。

```bash
npm run pdf -- https://zenn.dev/<user>/books/<slug>/viewer/<chapter-slug>
```

非公開の本，有料チャプターの本文は対象外です（取得できる範囲のみPDF化されます）。

## 動作確認

構文チェックは次のコマンドで実行します。

```bash
npm run check
```

## 実行時の表示

実行すると，次のように進捗が表示されます。

```text
[1/8] Launching Chromium.
[2/8] Opening the Zenn article page.
[3/8] Waiting for the article body.
[4/8] Loading lazy content by scrolling.
[5/8] Waiting briefly for images and fonts.
[6/8] Extracting the article content.
[7/8] Building a printable standalone page.
[8/8] Writing the PDF file.
Done.
```

## 仕様

- PlaywrightでZenn記事を開き，ブラウザのPDF出力機能でA4 PDFを作成します。
- Zennページ全体をそのまま印刷せず，記事本文の `.znc` 要素を中心に抽出して，PDF用の単独HTMLを作ってからPDF化します。
- ヘッダー，フッター，サイドバー，プロフィールカード，コメント欄はPDFに含めません。
- タイトル，出典URL，タグ，記事本文，画像，コードブロック，表をPDFに含めます。
- 画像はページ末尾までスクロールして読み込みを促してからPDF化します。
- 非公開記事，ログインが必要な記事，有料記事の本文は対象外です。

## 表示確認用HTMLを保存する

PDFの体裁を確認したい場合は，PDF化直前のHTMLを保存できます。

```bash
npm run pdf -- https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5 --debug-html debug/zenn-pdf-article.html
```

HTMLをブラウザで開くと，PDFに入る本文の幅，コードブロック，表，画像の状態を確認できます。

## よくあるエラー

### `Executable doesn't exist` と表示される

Chromiumが未導入です。次を実行してください。

```bash
npx playwright install chromium
```

### `The URL must point to a Zenn article (...) or a Zenn book (...)` と表示される

ZennのユーザーURLやトップページではなく，記事URLまたは本のURLを指定してください。

```text
https://zenn.dev/<user>/articles/<slug>
https://zenn.dev/<user>/books/<slug>
https://zenn.dev/<user>/books/<slug>/viewer/<chapter-slug>
```

### PDFの本文が細い列になる

Zennの画面レイアウトがPDFに残ると，本文が左側の細い列に押し込まれることがあります。このツールでは `.znc` の本文を抽出し，PDF用の単独HTMLに組み直してから出力します。

### 途中で止まる

最後に表示されたステップを確認してください。ネットワークが遅い場合は，次のように待機時間を伸ばせます。

```bash
npm run pdf -- https://zenn.dev/kato_aichi/articles/bad1d62fd7c9f5 --timeout 120000
```
