/**
 * <tg-checkbox>
 *
 * Attributes:
 *   checked   — boolean
 *   label     — optional label (falls back to textContent)
 *   variant   — "default" | "emphasis" (bolder text, used for "All")
 *
 * Events:
 *   change    — detail: { checked }
 *
 * Properties:
 *   .checked
 */
class TgCheckbox extends HTMLElement {
  static get observedAttributes() { return ['checked', 'label', 'variant']; }

  connectedCallback() {
    if (this._rendered) return;
    this._label = (this.getAttribute('label') || this.textContent || '').trim();
    this.addEventListener('click', (e) => {
      // Avoid stealing clicks from interactive children (none by default)
      if (e.defaultPrevented) return;
      this.checked = !this.checked;
      this.dispatchEvent(new CustomEvent('change', { detail: { checked: this.checked }, bubbles: true }));
    });
    this._render();
    this._rendered = true;
  }

  attributeChangedCallback() { if (this._rendered) this._render(); }

  get checked() { return this.hasAttribute('checked'); }
  set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }

  _render() {
    const checked = this.checked;
    const variant = this.getAttribute('variant') || 'default';

    this.classList.add('tg-checkbox');
    this.classList.toggle('checked', checked);
    this.classList.toggle('emphasis', variant === 'emphasis');
    this.setAttribute('role', 'checkbox');
    this.setAttribute('aria-checked', String(checked));
    this.setAttribute('tabindex', '0');

    this.innerHTML = `
      <span class="tg-checkbox-box" aria-hidden="true">${checked ? '✓' : ''}</span>
      <span class="tg-checkbox-label">${this._label}</span>
    `;
  }
}
customElements.define('tg-checkbox', TgCheckbox);
export { TgCheckbox };
