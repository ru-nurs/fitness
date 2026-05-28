const addButton = document.querySelector('[data-add-exercise]');
let dragged = null;

function bindBuilderRow(row) {
  row.addEventListener('dragstart', () => {
    dragged = row;
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    dragged = null;
    row.classList.remove('dragging');
  });
  row.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (dragged && dragged !== row) row.parentNode.insertBefore(dragged, row);
  });
}

if (addButton) {
  addButton.addEventListener('click', () => {
    const rows = document.querySelector('#exerciseRows');
    const clone = rows.querySelector('.builder-row').cloneNode(true);
    clone.querySelectorAll('input').forEach((input) => {
      if (input.name === 'sets') input.value = '3';
      else if (input.name === 'reps') input.value = '10';
      else if (input.name === 'rest_seconds') input.value = '60';
      else input.value = '';
    });
    bindBuilderRow(clone);
    rows.appendChild(clone);
  });
}

document.querySelectorAll('.builder-row').forEach(bindBuilderRow);
