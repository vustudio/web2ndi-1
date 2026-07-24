/**
 * <tg-header>
 *
 * A page header component with branding and navigation.
 *
 * Attributes:
 *   title      — main title text
 *   subtitle   — optional subtitle text
 *   show-nav   — boolean; shows navigation links
 *
 * Usage:
 *   <tg-header title="My App" subtitle="vanilla web components" show-nav></tg-header>
 */
class TgHeader extends HTMLElement {
  static get observedAttributes() { return ['title', 'subtitle', 'show-nav']; }

  connectedCallback() {
    if (this._rendered) return;
    this._render();
    this._rendered = true;
  }

  attributeChangedCallback() { if (this._rendered) this._render(); }

  _render() {
    const title = this.getAttribute('title') || '';
    const subtitle = this.getAttribute('subtitle') || '';
    const showNav = this.hasAttribute('show-nav');

    // Preserve any slotted <a> children before clearing
    const links = Array.from(this.children).filter(el => el.tagName === 'A');

    this.classList.add('tg-header');

    let html = `
      <div class="tg-header-brand">
        ${title ? `<div class="tg-header-title">${this._escapeHtml(title)}</div>` : ''}
        ${subtitle ? `<div class="tg-header-subtitle">${this._escapeHtml(subtitle)}</div>` : ''}
      </div>
    `;

    if (showNav && links.length) {
      html += `<nav class="tg-header-nav"></nav>`;
    }

    this.innerHTML = html;

    // Move original links into nav to preserve attributes & listeners
    if (showNav && links.length) {
      const nav = this.querySelector('.tg-header-nav');
      links.forEach(a => {
        a.classList.add('tg-header-link');
        nav.appendChild(a);
      });
    }
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
customElements.define('tg-header', TgHeader);
export { TgHeader };
