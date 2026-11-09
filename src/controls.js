// Input handling + DOM builders for the game shell.
import { CELLS } from './puzzle.js';

// Build the 8 cell tiles into the top/bottom strips (cells 0–3 top, 4–7 bottom).
export function buildCellTiles() {
  const top = document.getElementById('cells-top');
  const bottom = document.getElementById('cells-bottom');
  top.innerHTML = ''; bottom.innerHTML = '';
  CELLS.forEach((cell, i) => {
    const tile = document.createElement('div');
    tile.className = 'cell-tile';
    tile.dataset.cell = i;
    tile.style.setProperty('--cell', rgbToHex(cell.color));
    tile.innerHTML = `<span class="tile-name">${cell.name}</span>`;
    (i < 4 ? top : bottom).appendChild(tile);
  });
}

// Mark the centred cell's tile.
export function setCenteredTile(idx) {
  document.querySelectorAll('.cell-tile').forEach(el => {
    el.classList.toggle('centered', +el.dataset.cell === idx);
  });
}

function rgbToHex([r, g, b]) {
  const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
