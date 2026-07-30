// Shared core: flat frontmatter parse/serialize. UMD: Node (module.exports) + browser (window.CoreFrontmatter).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreFrontmatter = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // ---------- Frontmatter (flat YAML: status + comma-list tags) ----------
  function parseFrontmatter(text){
    if(!text.startsWith('---')) return { attrs:{}, body:text };
    const lines=text.split(/\r?\n/);
    if(lines[0].trim()!=='---') return { attrs:{}, body:text };
    let end=-1;
    for(let i=1;i<lines.length;i++){ if(lines[i].trim()==='---'){ end=i; break; } }
    if(end===-1) return { attrs:{}, body:text };
    const attrs={};
    for(let i=1;i<end;i++){
      const m=lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if(m){ let v=m[2].trim(); attrs[m[1]]=v; }
    }
    const body=lines.slice(end+1).join('\n').replace(/^\n+/,'');
    return { attrs, body };
  }
  function serializeFrontmatter(attrs, body){
    const keys=Object.keys(attrs).filter(k=>attrs[k]!==''&&attrs[k]!=null);
    if(!keys.length) return body;
    let fm='---\n';
    for(const k of keys) fm+=k+': '+attrs[k]+'\n';
    fm+='---\n\n';
    return fm+body;
  }
  return { parseFrontmatter: parseFrontmatter, serializeFrontmatter: serializeFrontmatter };
});
