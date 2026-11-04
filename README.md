# 次の回まで

講習会・セミナー・勉強会のあと、参加者がスマホで復習できるアプリです。
講習の文字起こしからAI（Claudeなど）で復習用の中身を作り、貼って公開します。次の回まで、学ぶ熱を冷まさない仕組み（足あと・準備・便り）が入っています。

## 置く

下のボタンを押し、画面の案内に沿って進みます。データベースと音声の置き場所は自動で用意されます。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yukawa-care/tsugi-no-kai)

置けたら、**すぐにアドレスを開いて「はじめの設定」を済ませてください**（講座の名前・講師の呼び名・分野・講師の合言葉の4つ）。最初に設定した人が講師になります。

使い方の詳しいことは、**主催者マニュアル**をご覧ください：https://tsugi-no-kai.bonojam.workers.dev/manual.html
（置いたあとは、自分のアプリの `/manual.html` でも読めます）

## 中身

| ファイル | 役目 |
| :---- | :---- |
| `public/index.html` | 参加者と講師の画面 |
| `src/index.js` | 合言葉・記録・音声 |
| `wrangler.toml` | Cloudflare の設定 |
| `oku.mjs` | パソコンの窓から置くときの台本（`node oku.mjs`） |
| `public/manual.html` | 主催者マニュアル |
