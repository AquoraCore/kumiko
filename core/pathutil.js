const path = require('path');

function vaultName(p){ return path.basename(p); }
function safeRel(name){
  if (!name) return null;
  const norm = path.normalize(String(name)).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.startsWith('..') || norm.includes('/../') || path.isAbsolute(norm)) return null;
  return norm;
}
function baseName(rel){ return path.basename(rel).replace(/\.md$/i, ''); }

module.exports = { safeRel, baseName, vaultName };
