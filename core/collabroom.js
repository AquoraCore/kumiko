// Namespace a collab room by the user so same-named notes of different users never collide.
// UMD: Node (module.exports) + browser (window.CoreCollabRoom).
// userKey = the logged-in email (stable per user); falls back to an unscoped room when absent
// (offline/not-logged-in desktop — it just won't share with the cloud, which is correct).
function collabRoomName(userKey, note){
  const n = String(note == null || note === '' ? 'untitled' : note);
  const u = userKey ? String(userKey).trim() : '';
  return u ? (u + '::' + n) : n;
}
if (typeof module!=='undefined'&&module.exports) module.exports={collabRoomName};
if (typeof window!=='undefined') window.CoreCollabRoom={collabRoomName};
