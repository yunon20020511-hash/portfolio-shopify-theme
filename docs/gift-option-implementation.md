# ギフトオプションの実装手順（他のストアに入れるときのメモ）

アプリを使わず、テーマのコードだけで「ギフト包装（有料）・のし・メッセージカード」を追加する手順です。
Dawn（バージョン 15〜16）を前提にしています。Dawn をもとにしたテーマ（Refresh、Sense、Craft など）もほぼ同じ構成です。

## 仕組み

```
商品ページ                         カート
┌──────────────────┐   /cart/add.js   ┌─────────────────────────────┐
│ □ ギフト包装する  │ ───────────────▶ │ ほうじ茶 ×2                  │
│   のし：御礼      │   items: [        │   ギフト包装：あり            │
│   カード：…      │     包装料 ×2,    │   のし：御礼   (_gift_id=abc) │
└──────────────────┘     本体 ×2 ]     │ ギフト包装料 ×2               │
                                       │   対象商品：ほうじ茶 (_gift_for=abc) │
                                       └─────────────────────────────┘
```

- 「のし」「メッセージカード」は **line item properties**（`properties[のし]`）で本体の行に付ける。注文管理画面と注文確認メールにも表示される
- 包装料は「ギフト包装料」という**別商品**（330円）。本体と**同じリクエスト**でカートに入れる
- 本体に `_gift_id`、包装料に同じ値の `_gift_for` を付けて 2 行を紐づける。**先頭が `_` のプロパティは、カート・チェックアウト・メールに表示されない**
- カートで本体の数量を変えたり削除したりすると、包装料の行も `/cart/update.js` でまとめて更新する
- 念のため、カートを表示するたびに Liquid で「本体のない包装料」「数量のずれ」を調べ、あれば JS が直す

### 別商品にした理由

| 方法 | 長所 | 短所 |
|---|---|---|
| **包装料を別商品にする（今回）** | アプリ不要。どのプランでも動く。売上レポートに包装料が出る | 本体との連動をテーマで作る必要がある |
| 本体のバリエーションに「ギフト包装あり」を足す | 連動が不要 | 全商品のバリエーションが倍になる。在庫管理が複雑 |
| Cart Transform（Shopify Functions）で価格を足す | 1 行で済む | アプリの開発が必要 |
| ギフト系アプリ | 早い | 月額費用。テーマとの干渉の原因になりやすい |

## 手順

### 1. 包装料の商品を作る

- 商品名「ギフト包装料」、価格 330円、商品タイプ「包装料」、在庫を追跡しない
- **オンラインストアの販売チャネルに公開する**（非公開だとカートに追加できない）
- 一覧に出ないよう、コレクションは「商品タイプが包装料と等しくない」の自動コレクションを使う

### 2. ファイルを追加する

| ファイル | 役割 |
|---|---|
| `snippets/gift-options.liquid` | 商品ページの入力欄。`form="{{ product_form_id }}"` で商品フォームに紐づける |
| `assets/gift-options.js` | 同時追加・連動・整合チェック（`window.GiftWrap`）と `<gift-options>` 要素 |
| `assets/component-gift-options.css` | 商品ページの見た目 |
| `snippets/gift-wrap-sync.liquid` | カートの整合チェック（直す内容を JSON で出す） |
| `snippets/gift-wrap-line-note.liquid` | 包装料の行に「数量は対象商品と連動」と表示 |

### 3. 既存ファイルを変更する

**`layout/theme.liquid`**：`base.css` の後に `gift-options.js` を読み込む（カートドロワーは全ページにあるため、商品ページ以外でも必要）

**`sections/main-product.liquid`**：
- `{%- when 'gift_options' -%}` で `gift-options` スニペットを表示
- schema の `blocks` に `gift_options` ブロックを追加（見出し、のし・カードの選択肢、表示の切り替え）

**`assets/product-form.js`**：`fetch` の直前に 1 か所、レスポンスの直後に 1 か所

```js
const giftRequest = window.GiftWrap?.buildAddRequest(this.form, formData);
if (giftRequest) {
  config.headers['Content-Type'] = 'application/json';
  config.body = giftRequest.body;
}
// ...
if (giftRequest) response = window.GiftWrap.normalizeAddResponse(response);
```

- 複数商品を追加すると、レスポンスが `{ items: [...] }` になる。テーマのカート通知は 1 商品分の形（`key` や `id`）を期待しているので、`normalizeAddResponse` で本体の行の形にそろえる
- 複数追加では、配列の**後ろの商品ほどカートの上**に並ぶ。本体を上に出すため `[包装料, 本体]` の順で送る

**`assets/cart.js`**（`updateQuantity`）：

```js
const giftUpdates = window.GiftWrap?.linkedUpdates(this, line, quantity);
const body = JSON.stringify({
  ...(giftUpdates ? { updates: giftUpdates } : { line, quantity }),
  sections: ..., sections_url: ...
});
fetch(giftUpdates ? routes.cart_update_url : routes.cart_change_url, ...)
```

- `/cart/update.js` は `updates: { 行のキー: 数量 }` で複数行を 1 回で更新でき、`sections` も返してくれる。返ってくる形が `/cart/change.js` とほぼ同じなので、その後の再描画処理はそのまま使える

**`sections/main-cart-items.liquid`・`snippets/cart-drawer.liquid`**：
- 行（`<tr>`）に `data-line-key="{{ item.key }}"` と `data-gift-id`（`_gift_id` または `_gift_for`）を付ける
- 包装料の行に `cart-item--gift-wrap` クラス（CSS で数量欄と削除ボタンを隠す）
- 表の後に `{% render 'gift-wrap-sync' %}`

**`config/settings_schema.json`**：「ギフト包装」グループに `gift_wrap_product`（product 型）

**`locales/*.json`・`*.schema.json`**：文言（ストアで使う言語の分）

### 4. 「今すぐ購入」ボタンへの対応

動的チェックアウトボタン（Shop Pay など）はカートを通らないため、包装料を追加できない。
ギフト包装にチェックがある間は JS でボタンを隠している。クライアントの希望によっては、購入ボタンブロックの「動的チェックアウトボタンを表示」をオフにする。

## 動作確認のチェックリスト

| 操作 | 期待する結果 |
|---|---|
| 包装なしで追加 | 本体だけが入る。プロパティなし |
| 包装ありで 2 個追加 | 本体 2・包装料 2。のし・カードが本体の行に表示 |
| 同じ商品を包装ありでもう一度追加 | 別の行になる（`_gift_id` が違うため）。包装料も別の行 |
| カートで本体を 3 に変更 | 包装料も 3 |
| カートで本体を削除 | 包装料も消える |
| 包装料の行 | 数量欄・削除ボタンが出ない |
| 包装料の商品ページから直接追加 | カートを開いたときに自動で 0 個になる |
| 在庫が 2 個しかない商品を 5 に変更 | 本体 2 に制限 → 整合チェックで包装料も 2 |
| チェックアウト画面 | のし・カードが表示され、`_gift_id` は表示されない |
| 注文管理画面 | 本体の行にのし・カードが表示される |

## 案件で気をつけること

- **テーマのバージョン**：`cart.js` の `updateQuantity` や `product-form.js` の中身は、Dawn のバージョンによって違うことがある。変更前に必ず該当箇所を読む
- **カートドロワー系のアプリ**（Upcart など）を使っている場合、カートの描画はアプリ側なので、`cart.js` の変更は効かない。整合チェック（`gift-wrap-sync`）を `/cart.js` を読む JS 版にするか、アプリの設定で対応する
- **作業は複製テーマで**行い、プレビューで上のチェックリストをすべて確認してから公開する
- 納品時は、包装料の商品を削除しないこと、のし・カードの選択肢の変え方をオーナー向けのメモで渡す（[owner-guide.md](owner-guide.md)）
