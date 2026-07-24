/**
 * <tg-stepper>
 *
 * Attributes:
 *   value   — default 0
 *   min     — default -Infinity
 *   max     — default Infinity
 *   step    — default 1
 *   suffix  — optional suffix appended to displayed value (e.g. "%")
 *
 * Events:
 *   change — detail: { value }
 */
class TgStepper extends HTMLElement {
  static get observedAttributes() { return ['value', 'min', 'max', 'step', 'suffix']; }

  connectedCallback() { if (!this._rendered) { this._render(); this._rendered = true; } }
  attributeChangedCallback() { if (this._rendered && !this._updating) this._render(); }

  get value() { return parseFloat(this.getAttribute('value') || '0'); }
  set value(v) { this.setAttribute('value', String(v)); }

  _render() {
    const suffix = this.getAttribute('suffix') || '';

    this.innerHTML = `
      <div class="stepper">
        <button class="stepper-btn" data-role="down">−</button>
        <span class="stepper-val" data-role="val"></span>
        <button class="stepper-btn" data-role="up">+</button>
      </div>
    `;

    const valEl = this.querySelector('[data-role="val"]');
    const paint = () => { valEl.textContent = `${this.value}${suffix}`; };

    this.querySelector('[data-role="down"]').addEventListener('click', () => this._step(-1));
    this.querySelector('[data-role="up"]').addEventListener('click', () => this._step(+1));
    paint();
    this._paint = paint;
  }

  _step(dir) {
    const step = parseFloat(this.getAttribute('step') || '1');
    const min = parseFloat(this.getAttribute('min') || '-Infinity');
    const max = parseFloat(this.getAttribute('max') || 'Infinity');
    let next = this.value + dir * step;
    if (next < min) next = min;
    if (next > max) next = max;
    this._updating = true;
    this.setAttribute('value', String(next));
    this._updating = false;
    this._paint();
    this.dispatchEvent(new CustomEvent('change', { detail: { value: next }, bubbles: true }));
  }
}
customElements.define('tg-stepper', TgStepper);
export { TgStepper };
