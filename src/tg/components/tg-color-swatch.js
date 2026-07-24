/**
 * <tg-color-swatch>
 *
 * Attributes:
 *   value       — current color (hex). Omit for "IDE Default" state.
 *   default     — default hex to show when no value (for swatch fill)
 *   placeholder — text shown when no value (default "IDE Default")
 *
 * Events:
 *   change — detail: { value }
 *   reset  — when the × button is clicked
 */
class TgColorSwatch extends HTMLElement {
  static get observedAttributes() { return ['value', 'default', 'placeholder']; }

  connectedCallback() { if (!this._rendered) { this._render(); this._rendered = true; } }
  attributeChangedCallback() { if (this._rendered && !this._updating) this._render(); }

  get value() { return this.getAttribute('value'); }
  set value(v) { v == null ? this.removeAttribute('value') : this.setAttribute('value', v); }

  _render() {
    const value = this.getAttribute('value');
    const fallback = this.getAttribute('default') || '#1e1e1e';
    const placeholder = this.getAttribute('placeholder') || 'IDE Default';
    const hasValue = !!value;

    this.classList.add('color-row');
    this.innerHTML = `
      <div class="color-swatch" data-role="swatch">
        <div class="color-swatch-fill" style="background: ${value || fallback};"></div>
        <input type="color" value="${value || fallback}" data-role="input">
      </div>
      <span class="color-val">${hasValue ? value : placeholder}</span>
      <button class="color-reset${hasValue ? '' : ' hidden'}" data-role="reset" title="Reset">×</button>
    `;

    const input = this.querySelector('[data-role="input"]');
    input.addEventListener('input', (e) => {
      this._updating = true;
      this.setAttribute('value', e.target.value);
      this._updating = false;
      this._render();
      this.dispatchEvent(new CustomEvent('change', { detail: { value: e.target.value }, bubbles: true }));
    });
    this.querySelector('[data-role="reset"]').addEventListener('click', () => {
      this._updating = true;
      this.removeAttribute('value');
      this._updating = false;
      this._render();
      this.dispatchEvent(new CustomEvent('reset', { bubbles: true }));
    });
  }
}
customElements.define('tg-color-swatch', TgColorSwatch);
export { TgColorSwatch };
