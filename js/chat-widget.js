// js/chat-widget.js — Floating chat bubble (advertiser: inline panel, admin: redirect to chat.html)
import { getSupabase } from './supabase.js';

let _sb = null, _user = null, _profile = null, _adminId = null;
let _panelOpen = false, _sub = null;

export async function initChatWidget() {
  try {
    _sb = await getSupabase();
    const { data: { user } } = await _sb.auth.getUser();
    if (!user) return;
    _user = user;

    const { data: profile } = await _sb.from('profiles')
      .select('id, name, role, status').eq('id', user.id).single();
    if (!profile || profile.status !== 'active') return;
    _profile = profile;

    const isAdmin = ['admin', 'superadmin'].includes(profile.role);

    if (!isAdmin) {
      // Advertiser: cari admin untuk diajak chat
      const { data: admins } = await _sb.from('profiles')
        .select('id').in('role', ['admin', 'superadmin']).limit(1);
      _adminId = admins?.[0]?.id;
      if (!_adminId) return; // tidak ada admin, skip
    }

    injectWidgetCSS();
    createBubble(isAdmin);
    if (!isAdmin) createChatPanel();
    await refreshBadge();
    subscribeRealtime(isAdmin);
  } catch (e) {
    console.warn('[ChatWidget]', e);
  }
}

// ── Badge unread count ──
async function refreshBadge() {
  if (!_sb || !_user) return;
  const { count } = await _sb.from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('is_read', false)
    .eq('receiver_id', _user.id);
  updateBadge(count || 0);
}

function updateBadge(count) {
  const badge = document.getElementById('chat-bubble-badge');
  const navBadge = document.getElementById('chat-nav-badge');
  const n = count > 99 ? '99+' : String(count);
  if (badge) { badge.textContent = n; badge.style.display = count > 0 ? 'flex' : 'none'; }
  if (navBadge) { navBadge.textContent = n; navBadge.style.display = count > 0 ? 'inline-flex' : 'none'; }
}

// ── Floating bubble ──
function createBubble(isAdmin) {
  if (document.getElementById('chat-bubble')) return;
  const el = document.createElement('div');
  el.id = 'chat-bubble';
  el.title = isAdmin ? 'Buka halaman Chat' : 'Chat dengan Admin';
  el.innerHTML = `<span id="chat-bubble-badge" style="display:none">0</span>💬`;
  el.addEventListener('click', () => {
    if (isAdmin) window.location.href = 'chat.html';
    else togglePanel();
  });
  document.body.appendChild(el);
}

// ── Chat panel (advertiser only) ──
function createChatPanel() {
  if (document.getElementById('chat-panel')) return;
  const el = document.createElement('div');
  el.id = 'chat-panel';
  el.innerHTML = `
    <div class="cwp-header">
      <div class="cwp-title"><span>💬</span><strong>Chat dengan Admin</strong></div>
      <button class="cwp-close" id="cwp-close-btn">✕</button>
    </div>
    <div class="cwp-messages" id="cwp-messages">
      <div class="cwp-loading" id="cwp-loading">Memuat pesan...</div>
    </div>
    <div class="cwp-footer">
      <input type="file" id="cwp-file" accept="image/*" style="display:none" />
      <button class="cwp-img-btn" id="cwp-img-btn" title="Kirim foto">📷</button>
      <input type="text" id="cwp-input" class="cwp-input" placeholder="Ketik pesan..." maxlength="2000" />
      <button class="cwp-send" id="cwp-send">➤</button>
    </div>
  `;
  document.body.appendChild(el);

  document.getElementById('cwp-img-btn').addEventListener('click', () => document.getElementById('cwp-file').click());
  document.getElementById('cwp-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await cwpSendImage(file);
  });

  document.getElementById('cwp-close-btn').addEventListener('click', () => {
    _panelOpen = false;
    el.classList.remove('open');
  });
  document.getElementById('cwp-send').addEventListener('click', cwpSend);
  document.getElementById('cwp-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cwpSend(); }
  });
}

async function togglePanel() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  _panelOpen = !_panelOpen;
  panel.classList.toggle('open', _panelOpen);
  if (_panelOpen) {
    await loadAndRenderMessages();
    markAllRead();
    document.getElementById('cwp-input')?.focus();
  }
}

// ── Load & render messages ──
async function loadAndRenderMessages() {
  const list = document.getElementById('cwp-messages');
  if (!list || !_sb || !_user || !_adminId) return;

  list.innerHTML = '<div class="cwp-loading">Memuat pesan...</div>';

  const { data: msgs } = await _sb.from('chat_messages')
    .select('*')
    .or(`and(sender_id.eq.${_user.id},receiver_id.eq.${_adminId}),and(sender_id.eq.${_adminId},receiver_id.eq.${_user.id})`)
    .order('created_at', { ascending: true })
    .limit(100);

  list.innerHTML = '';
  if (!msgs?.length) {
    list.innerHTML = '<div class="cwp-empty">Belum ada pesan. Mulai percakapan! 👋</div>';
    return;
  }
  msgs.forEach(m => appendMsg(m, list, false));
  list.scrollTop = list.scrollHeight;
}

function appendMsg(msg, list, scroll = true) {
  if (!list) list = document.getElementById('cwp-messages');
  if (!list || !_user) return;
  list.querySelector('.cwp-empty')?.remove();
  list.querySelector('.cwp-loading')?.remove();
  // avoid duplicates
  if (list.querySelector(`[data-id="${msg.id}"]`)) return;

  const isMine = msg.sender_id === _user.id;
  const time = new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = `cwp-msg ${isMine ? 'mine' : 'theirs'}`;
  el.dataset.id = msg.id;
  const imgHtml = msg.image_url
    ? `<img src="${msg.image_url}" class="cwp-img-preview" onclick="window.open('${msg.image_url}','_blank')" />`
    : '';
  const textHtml = msg.message ? `<div class="cwp-bubble">${escHtml(msg.message)}</div>` : '';
  el.innerHTML = imgHtml + textHtml + `<div class="cwp-time">${time}</div>`;
  list.appendChild(el);
  if (scroll) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

// ── Send message (advertiser) ──
async function cwpSend() {
  const input = document.getElementById('cwp-input');
  const btn = document.getElementById('cwp-send');
  const msg = input?.value?.trim();
  if (!msg || !_sb || !_user || !_adminId) return;

  btn.disabled = true;
  input.value = '';

  try {
    const { data: inserted, error } = await _sb.from('chat_messages').insert({
      sender_id: _user.id,
      receiver_id: _adminId,
      message: msg,
      image_url: null
    }).select().single();
    if (error) throw error;
    if (inserted) appendMsg(inserted, document.getElementById('cwp-messages'));
    sendWANotif(msg);
  } catch (e) {
    input.value = msg;
    console.warn('Send error:', e);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

async function cwpSendImage(file) {
  if (!_sb || !_user || !_adminId) return;
  if (!file.type.startsWith('image/')) { alert('Hanya file gambar yang diizinkan.'); return; }
  if (file.size > 5 * 1024 * 1024) { alert('Ukuran maksimal 5MB.'); return; }

  const imgBtn = document.getElementById('cwp-img-btn');
  if (imgBtn) { imgBtn.disabled = true; imgBtn.textContent = '⏳'; }

  try {
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${_user.id}/${Date.now()}.${ext}`;
    const { error: upErr } = await _sb.storage.from('chat-images').upload(path, file, { contentType: file.type });
    if (upErr) throw upErr;

    const { data: urlData } = _sb.storage.from('chat-images').getPublicUrl(path);
    const caption = document.getElementById('cwp-input')?.value?.trim() || '';
    if (caption) document.getElementById('cwp-input').value = '';

    const { data: inserted, error } = await _sb.from('chat_messages').insert({
      sender_id: _user.id,
      receiver_id: _adminId,
      message: caption,
      image_url: urlData.publicUrl
    }).select().single();
    if (error) throw error;
    if (inserted) appendMsg(inserted, document.getElementById('cwp-messages'));
    sendWANotif(caption || '📷 Mengirim foto');
  } catch (e) {
    alert('Gagal kirim foto: ' + e.message);
  } finally {
    if (imgBtn) { imgBtn.disabled = false; imgBtn.textContent = '📷'; }
  }
}

async function markAllRead() {
  if (!_sb || !_user || !_adminId) return;
  await _sb.from('chat_messages')
    .update({ is_read: true })
    .eq('receiver_id', _user.id)
    .eq('sender_id', _adminId)
    .eq('is_read', false);
  updateBadge(0);
}

// ── Supabase Realtime ──
function subscribeRealtime(isAdmin) {
  if (!_sb || !_user) return;
  _sub = _sb.channel('cwp-' + _user.id)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'chat_messages',
      filter: `receiver_id=eq.${_user.id}`
    }, async (payload) => {
      const msg = payload.new;
      if (!isAdmin && _panelOpen) {
        const list = document.getElementById('cwp-messages');
        appendMsg(msg, list);
        await _sb.from('chat_messages').update({ is_read: true }).eq('id', msg.id);
      } else {
        const badge = document.getElementById('chat-bubble-badge');
        const cur = parseInt(badge?.textContent || '0') || 0;
        updateBadge(cur + 1);
      }
    })
    .subscribe();
}

// ── WA notif ke admin saat advertiser kirim pesan ──
async function sendWANotif(message) {
  try {
    await fetch('/api/notify-wa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'chat_message',
        sender_id: _user?.id,
        sender_name: _profile?.name || 'Advertiser',
        message_preview: message.length > 80 ? message.slice(0, 80) + '...' : message
      })
    });
  } catch (_) {}
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

// ── CSS injected once ──
function injectWidgetCSS() {
  if (document.getElementById('cwp-css')) return;
  const s = document.createElement('style');
  s.id = 'cwp-css';
  s.textContent = `
    /* Floating bubble */
    #chat-bubble{position:fixed;bottom:24px;right:24px;width:52px;height:52px;border-radius:50%;background:var(--primary,#6366f1);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(99,102,241,.45);z-index:9998;transition:transform .2s,box-shadow .2s;user-select:none;}
    #chat-bubble:hover{transform:scale(1.08);box-shadow:0 6px 22px rgba(99,102,241,.55);}
    #chat-bubble-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;background:#ef4444;color:#fff;border-radius:9px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px;border:2px solid #fff;}

    /* Chat panel (advertiser) */
    #chat-panel{position:fixed;bottom:88px;right:24px;width:340px;height:480px;background:var(--bg-card,#fff);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.18);z-index:9997;display:flex;flex-direction:column;transform:translateY(16px) scale(.97);opacity:0;pointer-events:none;transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;overflow:hidden;border:1px solid var(--border,#e2e8f0);}
    #chat-panel.open{transform:translateY(0) scale(1);opacity:1;pointer-events:all;}
    .cwp-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border,#e2e8f0);background:var(--primary,#6366f1);color:#fff;flex-shrink:0;}
    .cwp-title{display:flex;align-items:center;gap:8px;font-size:14px;}
    .cwp-close{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0;opacity:.8;line-height:1;transition:opacity .15s;}
    .cwp-close:hover{opacity:1;}
    .cwp-messages{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--bg,#f8fafc);}
    .cwp-messages::-webkit-scrollbar{width:4px;} .cwp-messages::-webkit-scrollbar-thumb{background:var(--border,#e2e8f0);border-radius:2px;}
    .cwp-loading,.cwp-empty{text-align:center;color:var(--gray-5,#94a3b8);font-size:13px;padding:32px 0;}
    .cwp-msg{display:flex;flex-direction:column;max-width:82%;}
    .cwp-msg.mine{align-self:flex-end;align-items:flex-end;}
    .cwp-msg.theirs{align-self:flex-start;align-items:flex-start;}
    .cwp-bubble{padding:8px 12px;border-radius:14px;font-size:13px;line-height:1.5;word-break:break-word;}
    .cwp-msg.mine .cwp-bubble{background:var(--primary,#6366f1);color:#fff;border-bottom-right-radius:4px;}
    .cwp-msg.theirs .cwp-bubble{background:#fff;color:var(--text,#1e293b);border:1px solid var(--border,#e2e8f0);border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
    .cwp-time{font-size:10px;color:var(--gray-5,#94a3b8);margin-top:3px;padding:0 2px;}
    .cwp-footer{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--border,#e2e8f0);background:var(--bg-card,#fff);flex-shrink:0;}
    .cwp-input{flex:1;padding:9px 14px;border:1.5px solid var(--border,#e2e8f0);border-radius:20px;font-size:13px;outline:none;font-family:inherit;background:var(--bg,#f8fafc);color:var(--text,#1e293b);transition:border-color .2s;}
    .cwp-input:focus{border-color:var(--primary,#6366f1);}
    .cwp-send{background:var(--primary,#6366f1);color:#fff;border:none;border-radius:50%;width:36px;height:36px;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .2s;}
    .cwp-send:hover{background:#4f46e5;}
    .cwp-send:disabled{background:var(--gray-3,#cbd5e1);cursor:not-allowed;}
    .cwp-img-btn{background:none;border:none;font-size:18px;cursor:pointer;padding:0 4px;opacity:.7;transition:opacity .15s;flex-shrink:0;}
    .cwp-img-btn:hover{opacity:1;}
    .cwp-img-btn:disabled{opacity:.4;cursor:not-allowed;}
    .cwp-img-preview{max-width:200px;max-height:200px;border-radius:10px;cursor:pointer;display:block;margin-bottom:4px;object-fit:cover;}
    .cwp-msg.mine .cwp-img-preview{border-bottom-right-radius:3px;}
    .cwp-msg.theirs .cwp-img-preview{border-bottom-left-radius:3px;}

    /* Mobile */
    @media(max-width:480px){
      #chat-panel{width:calc(100vw - 32px);right:16px;bottom:80px;height:420px;}
      #chat-bubble{bottom:16px;right:16px;}
    }
  `;
  document.head.appendChild(s);
}
