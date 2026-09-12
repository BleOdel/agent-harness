const form = document.querySelector('form');
const input = document.querySelector('#note');
const status = document.querySelector('#status');
const list = document.querySelector('#notes');
function render(notes) {
  list.replaceChildren(...notes.map(title => {const item = document.createElement('li'); item.textContent = title; return item;}));
  document.querySelector('#empty').hidden = notes.length > 0;
}
window.notes.list().then(render).catch(() => {status.textContent = 'Could not load saved notes.';});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!input.value.trim()) {status.textContent = 'Write a note before saving.'; input.focus(); return;}
  try {render(await window.notes.add(input.value)); input.value = ''; status.textContent = 'Note saved.'; input.focus();}
  catch {status.textContent = 'Could not save the note. Try again.';}
});
