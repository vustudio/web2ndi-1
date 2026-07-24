/**
 * <tg-grid-selector>
 *
 * Attributes:
 *   max-rows     — default 4
 *   max-cols     — default 5
 *   rows         — selected rows (default 2)
 *   cols         — selected cols (default 3)
 *   show-label   — boolean; if present, renders size label below grid
 *
 * Events:
 *   change — detail: { rows, cols }
 *
 * Properties:
 *   .rows, .cols
 */
class TgGridSelector extends HTMLElement {
  static get observedAttributes() { return ['max-rows', 'max-cols', 'rows', 'cols', 'show-label']; }

  connectedCallback() { if (!this._rendered) { this._render(); this._rendered = true; } }
  attributeChangedCallback() { if (this._rendered) this._render(); }

  get rows() { return parseInt(this.getAttribute('rows') || '2', 10); }
  set rows(v) { this.setAttribute('rows', String(v)); }
  get cols() { return parseInt(this.getAttribute('cols') || '3', 10); }
  set cols(v) { this.setAttribute('cols', String(v)); }

  _render() {
    const maxRows = parseInt(this.getAttribute('max-rows') || '4', 10);
    const maxCols = parseInt(this.getAttribute('max-cols') || '5', 10);
    const showLabel = this.hasAttribute('show-label');

    let selectedRows = this.rows;
    let selectedCols = this.cols;
    let hoverRow = -1, hoverCol = -1;

    this.innerHTML = `
      <div class="grid-selector-wrap">
        <div class="grid-selector" data-role="grid"
             style="grid-template-columns: repeat(${maxCols}, 1fr);"></div>
      </div>
      ${showLabel ? `<div class="size-label" data-role="label"></div>` : ''}
    `;

    const gridEl = this.querySelector('[data-role="grid"]');
    const labelEl = this.querySelector('[data-role="label"]');
    const cells = [];

    for (let r = 0; r < maxRows; r++) {
      for (let c = 0; c < maxCols; c++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.addEventListener('mouseenter', () => { hoverRow = r; hoverCol = c; render(); });
        cell.addEventListener('click', () => {
          selectedRows = r + 1;
          selectedCols = c + 1;
          this.setAttribute('rows', String(selectedRows));
          this.setAttribute('cols', String(selectedCols));
          hoverRow = -1; hoverCol = -1;
          render();
          this.dispatchEvent(new CustomEvent('change', {
            detail: { rows: selectedRows, cols: selectedCols },
            bubbles: true,
          }));
        });
        gridEl.appendChild(cell);
        cells.push({ el: cell, row: r, col: c });
      }
    }
    gridEl.addEventListener('mouseleave', () => { hoverRow = -1; hoverCol = -1; render(); });

    const render = () => {
      const isH = hoverRow >= 0;
      const aR = isH ? hoverRow : selectedRows - 1;
      const aC = isH ? hoverCol : selectedCols - 1;
      for (const { el, row, col } of cells) {
        const inside = row <= aR && col <= aC;
        el.classList.toggle('highlight', inside && isH);
        el.classList.toggle('selected', inside && !isH);
      }
      if (labelEl) {
        labelEl.innerHTML = `<span class="num">${aR + 1}</span> × <span class="num">${aC + 1}</span>`;
      }
    };
    render();
  }
}
customElements.define('tg-grid-selector', TgGridSelector);
export { TgGridSelector };
