/**
 * <tg-dropdown>
 *
 * An upward-opening dropdown (font/theme picker pattern).
 *
 * Attributes:
 *   options      — JSON array: ["Fira Code", "JetBrains Mono"] or
 *                  [{"value":"fira","label":"Fira Code","removable":true}, ...]
 *   value        — currently selected value
 *   placeholder  — label shown when nothing selected (default "IDE Default")
 *   add-label    — optional; renders an "add" row below options (e.g. "+ Add font…")
 *   open         — boolean; initial open state
 *
 * Events:
 *   change — detail: { value, label }
 *   remove — detail: { value, label }
 *   add    — fires when "add" row clicked
 */
class TgDropdown extends HTMLElement {
  static get observedAttributes() { return ['options', 'value', 'placeholder', 'add-label', 'open']; }

  connectedCallback() {
    if (!this._rendered) {
      this._onOutside = (e) => {
        if (!this.contains(e.target) && this.hasAttribute('open')) this._toggle();
      };
      document.addEventListener('click', this._onOutside);
      this._render();
      this._rendered = true;
    }
  }

  disconnectedCallback() {
    if (this._onOutside) document.removeEventListener('click', this._onOutside);
  }

  attributeChangedCallback() { if (this._rendered && !this._updating) this._render(); }

  get value() { return this.getAttribute('value'); }
  set value(v) { v == null ? this.removeAttribute('value') : this.setAttribute('value', v); }

  _parseOptions() {
    try {
      return (JSON.parse(this.getAttribute('options') || '[]') || []).map(o =>
        typeof o === 'string' ? { value: o, label: o } : { value: o.value ?? o.label, label: o.label ?? o.value, removable: !!o.removable }
      );
    } catch { return []; }
  }

  _render() {
    const options = this._parseOptions();
    const value = this.getAttribute('value');
    const placeholder = this.getAttribute('placeholder') || 'IDE Default';
    const addLabel = this.getAttribute('add-label');
    const open = this.hasAttribute('open');
    const current = options.find(o => o.value === value);

    this.classList.add('font-picker');
    this.innerHTML = `
      <div class="font-display${open ? ' open' : ''}" data-role="display">
        <span class="font-display-text">${current ? current.label : placeholder}</span>
        <span class="font-display-arrow">▲</span>
      </div>
      <div class="font-dropdown${open ? ' show' : ''}" data-role="menu">
        ${options.map(o => `
          <div class="font-opt${o.value === value ? ' active' : ''}" data-value="${encodeURIComponent(o.value)}">
            <span class="font-opt-name">${o.label}</span>
            ${o.removable ? `<button class="font-opt-del" data-remove>×</button>` : ''}
          </div>
        `).join('')}
        ${addLabel ? `<div class="font-divider"></div><div class="font-opt-add" data-role="add">${addLabel}</div>` : ''}
      </div>
    `;

    const display = this.querySelector('[data-role="display"]');
    display.addEventListener('click', (e) => { e.stopPropagation(); this._toggle(); });

    this.querySelectorAll('.font-opt[data-value]').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.hasAttribute('data-remove')) return;
        const val = decodeURIComponent(opt.getAttribute('data-value'));
        const o = options.find(x => x.value === val);
        this._updating = true;
        this.setAttribute('value', val);
        this.removeAttribute('open');
        this._updating = false;
        this._render();
        this.dispatchEvent(new CustomEvent('change', { detail: { value: val, label: o?.label }, bubbles: true }));
      });
    });

    this.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opt = btn.closest('.font-opt');
        const val = decodeURIComponent(opt.getAttribute('data-value'));
        const o = options.find(x => x.value === val);
        this.dispatchEvent(new CustomEvent('remove', { detail: { value: val, label: o?.label }, bubbles: true }));
      });
    });

    const addBtn = this.querySelector('[data-role="add"]');
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('add', { bubbles: true }));
    });
  }

  _toggle() {
    const willOpen = !this.hasAttribute('open');
    this._updating = true;
    if (willOpen) this.setAttribute('open', ''); else this.removeAttribute('open');
    this._updating = false;
    this._render();
  }
}
customElements.define('tg-dropdown', TgDropdown);
export { TgDropdown };
