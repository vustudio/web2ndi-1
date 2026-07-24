/**
 * <tg-tabs>
 *
 * Attributes:
 *   tabs           — JSON array of labels, e.g. '["All","1","2","3"]'
 *                    Items may be objects: {"label":"2","hasOverride":true}
 *   active         — index of active tab (default 0)
 *
 * Events:
 *   change — detail: { index, label }
 */
class TgTabs extends HTMLElement {
  static get observedAttributes() { return ['tabs', 'active']; }

  connectedCallback() { if (!this._rendered) { this._render(); this._rendered = true; } }
  attributeChangedCallback() { if (this._rendered && !this._updating) this._render(); }

  get active() { return parseInt(this.getAttribute('active') || '0', 10); }
  set active(i) { this.setAttribute('active', String(i)); }

  _render() {
    let tabs = [];
    try { tabs = JSON.parse(this.getAttribute('tabs') || '[]'); } catch {}
    const active = this.active;

    this.classList.add('settings-tabs');

    this.innerHTML = tabs.map((t, i) => {
      const label = typeof t === 'string' ? t : t.label;
      const hasOverride = typeof t === 'object' && t.hasOverride;
      return `<button class="stab${i === active ? ' active' : ''}${hasOverride ? ' has-override' : ''}" data-idx="${i}">${label}</button>`;
    }).join('');

    this.querySelectorAll('button[data-idx]').forEach((b) => {
      b.addEventListener('click', () => {
        const idx = parseInt(b.getAttribute('data-idx'), 10);
        this._updating = true;
        this.setAttribute('active', String(idx));
        this._updating = false;
        this._render();
        const raw = tabs[idx];
        const label = typeof raw === 'string' ? raw : raw.label;
        this.dispatchEvent(new CustomEvent('change', { detail: { index: idx, label }, bubbles: true }));
      });
    });
  }
}
customElements.define('tg-tabs', TgTabs);
export { TgTabs };
