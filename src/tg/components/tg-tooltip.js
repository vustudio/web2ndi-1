/**
 * <tg-tooltip>
 *
 * Attributes:
 *   content   — tooltip body (plain text or simple HTML, used as innerHTML)
 *   example   — optional example block (monospace)
 *
 * Usage:
 *   <tg-tooltip content="Helpful hint." example="Ctrl+Wheel to zoom"></tg-tooltip>
 */
class TgTooltip extends HTMLElement {
  static get observedAttributes() { return ['content', 'example']; }

  connectedCallback() { if (!this._rendered) { this._render(); this._rendered = true; } }
  attributeChangedCallback() { if (this._rendered) this._render(); }

  _render() {
    const content = this.getAttribute('content') || '';
    const example = this.getAttribute('example');

    this.innerHTML = `
      <span class="tip-wrap">
        <span class="tip-icon">?</span>
        <div class="tip-bubble">
          ${content}
          ${example ? `<div class="tip-example">${example}</div>` : ''}
        </div>
      </span>
    `;
  }
}
customElements.define('tg-tooltip', TgTooltip);
export { TgTooltip };
