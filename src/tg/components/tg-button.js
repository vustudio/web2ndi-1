/**
 * <tg-button>
 *
 * Attributes:
 *   variant   — "default" | "primary"
 *   icon      — icon character/string (e.g. "▶", "+")
 *   disabled  — boolean
 *
 * Slots/content:
 *   textContent of the element becomes the button label
 *
 * Events:
 *   tg-click — fires on button click (unless disabled)
 */
class TgButton extends HTMLElement {
  static get observedAttributes() { return ['variant', 'icon', 'disabled']; }

  connectedCallback() {
    if (this._rendered) return;
    this._label = this.textContent.trim();
    this._render();
    this._rendered = true;
  }

  attributeChangedCallback() { if (this._rendered) this._render(); }

  _render() {
    const variant = this.getAttribute('variant') || 'default';
    const icon = this.getAttribute('icon');
    const disabled = this.hasAttribute('disabled');

    this.innerHTML = `
      <button class="glass-btn${variant === 'primary' ? ' primary' : ''}" ${disabled ? 'disabled' : ''}>
        ${icon ? `<span class="btn-icon">${icon}</span>` : ''}
        <span>${this._label}</span>
      </button>
    `;

    const btn = this.querySelector('button');
    btn.addEventListener('click', (e) => {
      if (disabled) return;
      this.dispatchEvent(new CustomEvent('tg-click', { detail: { originalEvent: e }, bubbles: true }));
    });
  }
}
customElements.define('tg-button', TgButton);
export { TgButton };
