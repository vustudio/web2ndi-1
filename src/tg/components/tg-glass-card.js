/**
 * <tg-glass-card>
 *
 * Attributes:
 *   label          — section label (uppercase tiny text)
 *   tooltip        — tooltip bubble text (optional)
 *   collapsible    — boolean; when present, header toggles body
 *   collapsed      — boolean; initial collapsed state
 *
 * Slots:
 *   (default)      — card body content
 *
 * Events:
 *   toggle         — detail: { collapsed }
 */
class TgGlassCard extends HTMLElement {
  static get observedAttributes() { return ['label', 'tooltip', 'collapsed', 'collapsible']; }

  connectedCallback() {
    if (this._rendered) return;
    this._bodyHtml = this.innerHTML;
    this._render();
    this._rendered = true;
  }

  attributeChangedCallback() {
    if (this._rendered) this._render();
  }

  _render() {
    const label = this.getAttribute('label') || '';
    const tooltip = this.getAttribute('tooltip') || '';
    const collapsible = this.hasAttribute('collapsible');
    const collapsed = this.hasAttribute('collapsed');

    this.classList.add('glass-card');
    this.classList.toggle('collapsed', collapsed);

    const hasHeader = label || tooltip || collapsible;
    this.innerHTML = `
      ${hasHeader ? `
        <div class="section-header${collapsible ? ' collapsible' : ''}" data-role="header">
          ${label ? `<div class="section-label">${label}</div>` : ''}
          ${tooltip ? `
            <span class="tip-wrap">
              <span class="tip-icon">?</span>
              <div class="tip-bubble">${tooltip}</div>
            </span>` : ''}
          ${collapsible ? `<span class="collapse-icon">▾</span>` : ''}
        </div>
      ` : ''}
      <div class="section-body" data-role="body">${this._bodyHtml}</div>
    `;

    if (collapsible) {
      const header = this.querySelector('[data-role="header"]');
      header.addEventListener('click', () => this._toggle());
    }
  }

  _toggle() {
    const willCollapse = !this.classList.contains('collapsed');
    this.classList.toggle('collapsed', willCollapse);
    if (willCollapse) this.setAttribute('collapsed', ''); else this.removeAttribute('collapsed');
    this.dispatchEvent(new CustomEvent('toggle', { detail: { collapsed: willCollapse }, bubbles: true }));
  }
}
customElements.define('tg-glass-card', TgGlassCard);
export { TgGlassCard };
