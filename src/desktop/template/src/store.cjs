const fs = require('node:fs/promises');
exports.load = async file => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
exports.add = async (file, title) => {
  if (typeof title !== 'string' || !title.trim()) throw new Error('Write a note before saving.');
  const notes = await exports.load(file);
  notes.push(title.trim());
  const temporary = `${file}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(notes)); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, {force:true}); }
  return notes;
};
