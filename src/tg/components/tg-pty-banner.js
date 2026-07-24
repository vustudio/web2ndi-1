/**
 * <tg-pty-banner>
 *
 * Attributes:
 *   message        — banner text
 *   action-label   — label for the action button (optional)
 *   icon           — icon char, default "⚠"
 *
 * Events:
 *   action         — fires when action button clicked
 */
class TgPtyBanner extends HTMLElement {
  static get observedAttributes() { return ['message', 'action-label', 'icon']; }

  connectedCallback() { if (!this._rendered) { this._render(); this._rendered = true; } }
  attributeChangedCallback() { if (this._rendered) this._render(); }

  _render() {
    const message = this.getAttribute('message') || '';
    const actionLabel = this.getAttribute('action-label');
    const icon = this.getAttribute('icon') || '⚠';

    this.classList.add('pty-banner');
    this.innerHTML = `
      <span class="pty-banner-icon">${icon}</span>
      <span class="pty-banner-text">${message}</span>
      ${actionLabel ? `<button class="pty-banner-btn" data-role="action">${actionLabel}</button>` : ''}
    `;

    const btn = this.querySelector('[data-role="action"]');
    if (btn) {
      btn.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('action', { bubbles: true }));
      });
    }
  }
}
customElements.define('tg-pty-banner', TgPtyBanner);
export { TgPtyBanner };
