/*
 * [カスタマイズ] ギフト包装オプション
 *
 * 仕組み
 * - 商品ページ：ギフト包装にチェックがあると、本体と包装料の商品を 1 回の /cart/add.js で同時に追加する。
 *   本体には _gift_id、包装料には同じ値の _gift_for を付けて、カート内で 2 行を紐づける
 *   （先頭が _ のプロパティは、カートやチェックアウトに表示されない）
 * - カート：本体の数量変更・削除は /cart/update.js で包装料の行もまとめて更新する（assets/cart.js から呼ぶ）
 * - 念のための整合チェック：本体のない包装料や、数量のずれがあれば、カートの Liquid（snippets/gift-wrap-sync.liquid）が
 *   修正内容を JSON で出力し、ここで /cart/update.js を送って直す
 */

window.GiftWrap = {
  // 商品フォームに対応する <gift-options> を返す
  findOptions(form) {
    // 商品フォームには name="id" の入力欄があり form.id はその要素を指すため、属性から取る
    return document.querySelector(`gift-options[data-form-id="${form.getAttribute('id')}"]`);
  },

  // product-form.js から呼ぶ。ギフト包装なしなら null を返し、通常の追加処理に任せる
  buildAddRequest(form, formData) {
    const options = this.findOptions(form);
    if (!options || !options.isSelected()) return null;

    const giftId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const quantity = parseInt(formData.get('quantity')) || 1;

    const mainItem = { id: Number(formData.get('id')), quantity, properties: { _gift_id: giftId } };
    for (const [name, value] of formData.entries()) {
      const match = name.match(/^properties\[(.+)\]$/);
      if (match && typeof value === 'string' && value.trim() !== '') mainItem.properties[match[1]] = value.trim();
    }
    if (formData.get('selling_plan')) mainItem.selling_plan = formData.get('selling_plan');

    const wrapItem = {
      id: Number(options.dataset.wrapVariantId),
      quantity,
      properties: { [options.dataset.targetLabel]: options.dataset.productTitle, _gift_for: giftId },
    };

    // 複数商品を同時に追加すると、配列の後ろの商品ほどカートの上に並ぶ。本体 → 包装料の順に表示するため包装料を先に送る
    const body = { items: [wrapItem, mainItem] };
    if (formData.get('sections')) {
      body.sections = formData.get('sections');
      body.sections_url = formData.get('sections_url');
    }
    return { body: JSON.stringify(body), variantId: mainItem.id };
  },

  // 複数追加のレスポンス（items 配列）を、テーマ側が期待する 1 商品分の形にそろえる
  normalizeAddResponse(response) {
    if (!response || !Array.isArray(response.items)) return response;
    const mainItem = response.items.find((item) => !item.properties?._gift_for) || response.items[0];
    return { ...mainItem, sections: response.sections, items: response.items };
  },

  // assets/cart.js から呼ぶ。ギフトで紐づいた行なら、まとめて更新する { 行のキー: 数量 } を返す
  linkedUpdates(cartItems, line, quantity) {
    const row = cartItems.querySelector(`#CartItem-${line}, #CartDrawer-Item-${line}`);
    const giftId = row?.dataset.giftId;
    if (!giftId) return null;

    const updates = {};
    cartItems.querySelectorAll('[data-gift-id]').forEach((linkedRow) => {
      if (linkedRow.dataset.giftId === giftId) updates[linkedRow.dataset.lineKey] = quantity;
    });
    return Object.keys(updates).length > 1 ? updates : null;
  },

  // 本体のない包装料や数量のずれを直す
  syncIfNeeded() {
    if (this.syncing) return;
    const source = document.querySelector('[data-gift-wrap-sync]');
    if (!source) return;

    let updates;
    try {
      updates = JSON.parse(source.textContent);
    } catch (e) {
      updates = null;
    }
    // カートページではページ本体とドロワーの両方に同じ内容が出るので、古い内容が後で再送されないようすべて消す
    document.querySelectorAll('[data-gift-wrap-sync]').forEach((element) => element.remove());
    if (!updates || Object.keys(updates).length === 0) return;

    const cartItems = document.querySelector('cart-items') || document.querySelector('cart-drawer-items');
    const sections = cartItems ? cartItems.getSectionsToRender() : [];
    const body = JSON.stringify({
      updates,
      sections: sections.map((section) => section.section),
      sections_url: window.location.pathname,
    });

    this.syncing = true;
    fetch(`${routes.cart_update_url}`, { ...fetchConfig(), body })
      .then((response) => response.json())
      .then((cart) => {
        if (!cart.sections) return;
        sections.forEach((section) => {
          const container = document.getElementById(section.id);
          if (!container || !cart.sections[section.section]) return;
          const target = container.querySelector(section.selector) || container;
          target.innerHTML = cartItems.getSectionInnerHTML(cart.sections[section.section], section.selector);
        });
        const cartDrawer = document.querySelector('cart-drawer');
        if (cartDrawer) cartDrawer.classList.toggle('is-empty', cart.item_count === 0);
      })
      .catch((e) => console.error(e))
      .finally(() => {
        this.syncing = false;
      });
  },
};

if (!customElements.get('gift-options')) {
  customElements.define(
    'gift-options',
    class GiftOptions extends HTMLElement {
      connectedCallback() {
        this.checkbox = this.querySelector('.gift-options__checkbox');
        this.details = this.querySelector('.gift-options__details');
        if (!this.checkbox) return;

        this.checkbox.addEventListener('change', this.toggle.bind(this));
        this.toggle();
      }

      isSelected() {
        return Boolean(this.checkbox?.checked && this.dataset.wrapVariantId);
      }

      toggle() {
        const selected = this.checkbox.checked;
        this.details.hidden = !selected;
        // 無効にした入力欄はフォームから送られないので、包装なしのときに「のし」などが付かない
        this.details.querySelectorAll('select, textarea').forEach((field) => (field.disabled = !selected));

        // 「今すぐ購入」はカートを通らず包装料を追加できないため、ギフト包装を選んだときは隠す
        const productForm = document.getElementById(this.dataset.formId);
        productForm?.querySelectorAll('.shopify-payment-button').forEach((button) => {
          button.style.display = selected ? 'none' : '';
        });
      }
    }
  );
}

document.addEventListener('DOMContentLoaded', () => {
  window.GiftWrap.syncIfNeeded();
  if (typeof subscribe === 'function') {
    subscribe(PUB_SUB_EVENTS.cartUpdate, () => setTimeout(() => window.GiftWrap.syncIfNeeded(), 300));
  }
});
