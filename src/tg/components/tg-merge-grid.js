/**
 * <tg-merge-grid>
 *
 * Interactive drag-to-select merge preview grid. Users drag to select a
 * rectangle, then use merge/unmerge/clear actions. Merged regions render
 * as spanning cells.
 *
 * Attributes:
 *   rows, cols       — grid dimensions (default 2×3)
 *
 * Methods:
 *   merge()          — merge current selection (if valid)
 *   unmerge()        — unmerge clicked region
 *   clear()          — clear all merged regions
 *   canMerge         — getter, whether current selection is mergeable
 *   canUnmerge       — getter, whether clicked region is a merged region
 *   regions          — getter, array of merged regions
 *
 * Events:
 *   change           — detail: { regions } — fires when regions change
 *   selection        — detail: { rect, canMerge, canUnmerge } — fires during interaction
 */
class TgMergeGrid extends HTMLElement {
  static get observedAttributes() { return ['rows', 'cols']; }

  connectedCallback() {
    if (!this._rendered) {
      this._regions = [];
      this._selStart = null;
      this._selEnd = null;
      this._dragging = false;
      this._render();
      this._onMouseUp = () => { if (this._dragging) { this._dragging = false; this._paint(); } };
      document.addEventListener('mouseup', this._onMouseUp);
      this._rendered = true;
    }
  }

  disconnectedCallback() { document.removeEventListener('mouseup', this._onMouseUp); }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._rendered) return;
    if (oldV !== newV && (name === 'rows' || name === 'cols')) {
      this._regions = [];
      this._selStart = null;
      this._selEnd = null;
      this._render();
      this._emitChange();
    }
  }

  get rows() { return parseInt(this.getAttribute('rows') || '2', 10); }
  get cols() { return parseInt(this.getAttribute('cols') || '3', 10); }
  get regions() { return this._regions.slice(); }
  get canMerge() {
    const rect = this._getRect();
    if (!rect) return false;
    return this._compat(rect).conflicts.length === 0;
  }
  get canUnmerge() {
    if (!this._selStart || this._selEnd && (this._selStart.row !== this._selEnd.row || this._selStart.col !== this._selEnd.col)) return false;
    return !!this._regionAt(this._selStart.row, this._selStart.col);
  }

  _render() {
    const { rows, cols } = this;
    this.classList.add('merge-grid');
    this.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this.innerHTML = '';
    this._cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('div');
        cell.className = 'merge-cell';
        cell.textContent = String(r * cols + c + 1);
        cell.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this._dragging = true;
          this._selStart = { row: r, col: c };
          this._selEnd = { row: r, col: c };
          this._paint();
        });
        cell.addEventListener('mouseenter', () => {
          if (this._dragging && this._selStart) {
            this._selEnd = { row: r, col: c };
            this._paint();
          }
        });
        this.appendChild(cell);
        this._cells.push({ el: cell, row: r, col: c });
      }
    }
    this._paint();
  }

  _getRect() {
    if (!this._selStart || !this._selEnd) return null;
    const r1 = Math.min(this._selStart.row, this._selEnd.row);
    const r2 = Math.max(this._selStart.row, this._selEnd.row);
    const c1 = Math.min(this._selStart.col, this._selEnd.col);
    const c2 = Math.max(this._selStart.col, this._selEnd.col);
    if (r1 === r2 && c1 === c2) return null;
    return { r1, r2, c1, c2 };
  }

  _regionAt(row, col) {
    return this._regions.find(m =>
      row >= m.startRow && row < m.startRow + m.rowSpan &&
      col >= m.startCol && col < m.startCol + m.colSpan
    ) || null;
  }

  _compat(rect) {
    const absorbed = [], conflicts = [];
    this._regions.forEach((m, i) => {
      const mR1 = m.startRow, mR2 = m.startRow + m.rowSpan - 1;
      const mC1 = m.startCol, mC2 = m.startCol + m.colSpan - 1;
      const overlaps = !(mR2 < rect.r1 || mR1 > rect.r2 || mC2 < rect.c1 || mC1 > rect.c2);
      if (!overlaps) return;
      const full = mR1 >= rect.r1 && mR2 <= rect.r2 && mC1 >= rect.c1 && mC2 <= rect.c2;
      (full ? absorbed : conflicts).push(i);
    });
    return { absorbed, conflicts };
  }

  _paint() {
    const { cols } = this;
    const rect = this._getRect();
    let clickedRegion = null;
    if (!rect && this._selStart && !this._dragging) {
      clickedRegion = this._regionAt(this._selStart.row, this._selStart.col);
    }
    for (const { el, row, col } of this._cells) {
      el.className = 'merge-cell';
      el.style.gridColumn = String(col + 1);
      el.style.gridRow = String(row + 1);
      el.style.display = '';
      el.textContent = String(row * cols + col + 1);

      const region = this._regionAt(row, col);
      if (region) {
        if (row === region.startRow && col === region.startCol) {
          el.classList.add('merged', 'merged-origin');
          el.style.gridColumn = `${col + 1} / span ${region.colSpan}`;
          el.style.gridRow = `${row + 1} / span ${region.rowSpan}`;
          const nums = [];
          for (let rr = region.startRow; rr < region.startRow + region.rowSpan; rr++)
            for (let cc = region.startCol; cc < region.startCol + region.colSpan; cc++)
              nums.push(rr * cols + cc + 1);
          el.textContent = nums.join('+');
        } else {
          el.style.display = 'none';
        }
      }

      if (rect && row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2) {
        el.classList.add('selecting');
      }
      if (clickedRegion && region === clickedRegion) el.classList.add('selecting');
    }
    this.dispatchEvent(new CustomEvent('selection', {
      detail: { rect, canMerge: this.canMerge, canUnmerge: this.canUnmerge },
      bubbles: true,
    }));
  }

  merge() {
    const rect = this._getRect();
    if (!rect) return;
    const { conflicts, absorbed } = this._compat(rect);
    if (conflicts.length) return;
    absorbed.slice().sort((a, b) => b - a).forEach(i => this._regions.splice(i, 1));
    this._regions.push({
      startRow: rect.r1, startCol: rect.c1,
      rowSpan: rect.r2 - rect.r1 + 1, colSpan: rect.c2 - rect.c1 + 1,
    });
    this._selStart = null; this._selEnd = null;
    this._paint();
    this._emitChange();
  }

  unmerge() {
    if (!this._selStart) return;
    const region = this._regionAt(this._selStart.row, this._selStart.col);
    if (!region) return;
    const i = this._regions.indexOf(region);
    if (i >= 0) this._regions.splice(i, 1);
    this._selStart = null; this._selEnd = null;
    this._paint();
    this._emitChange();
  }

  clear() {
    this._regions = [];
    this._selStart = null;
    this._selEnd = null;
    this._paint();
    this._emitChange();
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { regions: this.regions },
      bubbles: true,
    }));
  }
}
customElements.define('tg-merge-grid', TgMergeGrid);
export { TgMergeGrid };
