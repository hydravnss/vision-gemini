/**
 * Vision Gemini — Gemini décrit les images (visage, cheveux, objets, voitures)
 * et envoie cette description au modèle texte (DeepSeek).
 */

const MODULE_NAME = 'vision_gemini';
const LOG = '[Vision Gemini]';
const SECRET_KEY = 'api_key_makersuite';

const DEFAULT_PROMPT = `Décris cette image de façon factuelle et précise, en français. Mentionne uniquement ce qui est visible, en détaillant notamment :
- visages : traits, expression, âge apparent, regard, maquillage
- cheveux : couleur, coupe, longueur, texture, style
- corps et vêtements
- objets identifiables et leur position
- véhicules / voitures : type, couleur, marque ou modèle si reconnaissable
- décor, éclairage, ambiance
Sois concret et organisé, sans inventer.`;

const DEFAULT_TEMPLATE = '[Description de l\'image : {{caption}}]';

const defaultSettings = Object.freeze({
    enabled: true,
    auto: true,
    showInChat: true,
    model: 'gemini-3.8-flash',
    prompt: DEFAULT_PROMPT,
    template: DEFAULT_TEMPLATE,
});

const ctx = () => SillyTavern.getContext();
const save = () => ctx().saveSettingsDebounced();

let settings = null;
let busy = false;

function loadSettings() {
    const store = ctx().extensionSettings;
    store[MODULE_NAME] = Object.assign({}, defaultSettings, store[MODULE_NAME] || {});
    if (!store[MODULE_NAME].prompt) {
        store[MODULE_NAME].prompt = DEFAULT_PROMPT;
    }
    if (!store[MODULE_NAME].template) {
        store[MODULE_NAME].template = DEFAULT_TEMPLATE;
    }
    settings = store[MODULE_NAME];
    const deprecated = new Set([
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
        'gemini-pro-vision',
    ]);
    if (!settings.model || deprecated.has(settings.model)) {
        settings.model = 'gemini-3.8-flash';
        save();
    }
}

function requestHeaders() {
    if (typeof ctx().getRequestHeaders === 'function') {
        return ctx().getRequestHeaders();
    }
    return { 'Content-Type': 'application/json' };
}

function wrapCaption(caption) {
    let template = (settings && settings.template) || DEFAULT_TEMPLATE;
    if (!/\{\{caption\}\}/i.test(template)) {
        template += ' {{caption}}';
    }
    return template.replace(/\{\{caption\}\}/gi, caption);
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('lecture image'));
        reader.readAsDataURL(blob);
    });
}

async function hasGeminiKey() {
    try {
        const res = await fetch('/api/secrets/read', {
            method: 'POST',
            headers: requestHeaders(),
        });
        if (!res.ok) {
            return false;
        }
        const state = await res.json();
        const entry = state && state[SECRET_KEY];
        return !!(entry === true || (Array.isArray(entry) && entry.length) || (entry && typeof entry === 'object'));
    } catch (err) {
        console.debug(LOG, 'secrets', err);
        return false;
    }
}

async function saveGeminiKey(value) {
    const res = await fetch('/api/secrets/write', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({
            key: SECRET_KEY,
            value,
            label: 'Gemini',
        }),
    });
    if (!res.ok) {
        throw new Error('enregistrement de la clé refusé');
    }
}

async function captionWithGemini(dataUrl) {
    const res = await fetch('/api/google/caption-image', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({
            image: dataUrl,
            prompt: settings.prompt || DEFAULT_PROMPT,
            model: settings.model || 'gemini-3.8-flash',
            api: 'google',
        }),
    });
    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch (err) {
            detail = '';
        }
        console.warn(LOG, 'caption http', res.status, detail);
        let parsed = detail;
        try {
            const json = JSON.parse(detail);
            parsed = json?.error?.message || json?.message || json?.error || detail;
        } catch (err) {
            parsed = detail;
        }
        const msg = String(parsed || '');
        if (/no longer available|NOT_FOUND|is not found|not found/i.test(msg)) {
            throw new Error('Ce modèle Gemini n’est plus disponible. L’extension va passer sur gemini-3.8-flash : recharge la page et renvoie l’image.');
        }
        if (/API[_ ]?key|PERMISSION|UNAUTHENTICATED|invalid.*key/i.test(msg)) {
            throw new Error('Clé API Gemini refusée. Vérifie-la dans Extensions → Vision Gemini.');
        }
        throw new Error('Gemini n’a pas pu décrire l’image');
    }
    const data = await res.json();
    const caption = String(data.caption || '').trim();
    if (!caption) {
        throw new Error('Réponse Gemini vide');
    }
    return caption;
}

function isImageMedia(media) {
    if (!media || !media.url) {
        return false;
    }
    if (media.type && /audio|video/i.test(String(media.type))) {
        return false;
    }
    return true;
}

async function describeMedia(media) {
    const result = await fetch(media.url);
    if (!result.ok) {
        throw new Error('image inaccessible');
    }
    const blob = await result.blob();
    let dataUrl = await blobToDataUrl(blob);
    if (!dataUrl.startsWith('data:')) {
        throw new Error('format image invalide');
    }
    if (dataUrl.startsWith('data:application/octet-stream') || dataUrl.startsWith('data:;')) {
        const mime = blob.type || 'image/jpeg';
        dataUrl = dataUrl.replace(/^data:[^;]*/, `data:${mime}`);
    }
    return captionWithGemini(dataUrl);
}

async function applyCaptionToMessage(message, media, caption) {
    const wrapped = wrapCaption(caption);
    media.title = wrapped;
    media.captioned = true;
    media.vg_captioned = true;

    const current = String(message.mes || '').trim();
    const show = !!(settings && settings.showInChat);

    if (!current) {
        message.mes = wrapped;
        if (!message.extra) {
            message.extra = {};
        }
        message.extra.inline_image = show;
        media.append_title = false;
    } else if (show) {
        if (!current.includes(wrapped)) {
            message.mes = `${current}\n\n${wrapped}`;
        }
        media.append_title = false;
    } else {
        media.append_title = true;
    }
}

async function refreshMessage(messageId) {
    try {
        if (typeof ctx().saveChat === 'function') {
            await ctx().saveChat();
        }
        const { eventSource, event_types } = ctx();
        if (eventSource && event_types && event_types.MESSAGE_UPDATED) {
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        }
    } catch (err) {
        console.debug(LOG, 'rafraîchir', err);
    }
}

async function captionMessage(messageId) {
    if (!(settings && settings.enabled)) {
        return;
    }
    const message = ctx().chat && ctx().chat[messageId];
    if (!message || !Array.isArray(message.extra?.media) || !message.extra.media.length) {
        return;
    }

    let changed = false;
    for (const media of message.extra.media) {
        if (!isImageMedia(media) || media.captioned || media.vg_captioned) {
            continue;
        }
        try {
            const caption = await describeMedia(media);
            await applyCaptionToMessage(message, media, caption);
            changed = true;
        } catch (err) {
            console.warn(LOG, err);
            window.toastr?.error?.(err.message || 'Vision Gemini a échoué', 'Vision Gemini');
        }
    }

    if (changed) {
        await refreshMessage(messageId);
    }
}

async function onMessageEvent(messageId) {
    if (!(settings && settings.enabled && settings.auto) || busy) {
        return;
    }
    busy = true;
    try {
        await captionMessage(Number(messageId));
    } finally {
        busy = false;
    }
}

async function updateKeyStatus() {
    const el = document.getElementById('vg_key_status');
    if (!el) {
        return;
    }
    const ok = await hasGeminiKey();
    el.textContent = ok ? 'Clé Gemini enregistrée.' : 'Aucune clé Gemini pour l’instant.';
    el.classList.toggle('ok', ok);
    el.classList.toggle('missing', !ok);
}

const SETTINGS_HTML = `
<div id="vg_settings" class="extension_container">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Vision Gemini</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="vg-hint">Gemini décrit tes images (visage, cheveux, objets, voitures…) et envoie cette description à DeepSeek avec ton message.</div>
      <div class="vg-row">
        <label for="vg_enabled">Activer</label>
        <input type="checkbox" id="vg_enabled">
      </div>
      <div class="vg-col">
        <label for="vg_api_key">Clé API Gemini</label>
        <div class="vg-key-row">
          <input type="password" id="vg_api_key" class="text_pole" placeholder="AIza…" autocomplete="off">
          <button type="button" class="menu_button" id="vg_save_key">Enregistrer</button>
        </div>
        <div id="vg_key_status" class="vg-status missing">Aucune clé Gemini pour l’instant.</div>
      </div>
      <div class="vg-col">
        <label for="vg_model">Modèle</label>
        <select id="vg_model" class="text_pole">
          <option value="gemini-3.8-flash">gemini-3.8-flash</option>
          <option value="gemini-3.6-flash">gemini-3.6-flash</option>
          <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite</option>
          <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
          <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
        </select>
      </div>
      <div class="vg-row">
        <label for="vg_auto">Décrire automatiquement les images envoyées</label>
        <input type="checkbox" id="vg_auto">
      </div>
      <div class="vg-row">
        <label for="vg_show">Afficher la description dans le chat</label>
        <input type="checkbox" id="vg_show">
      </div>
      <div class="vg-col">
        <label for="vg_prompt">Consigne envoyée à Gemini</label>
        <textarea id="vg_prompt" class="text_pole" rows="8"></textarea>
      </div>
      <div class="vg-col">
        <label for="vg_template">Texte ajouté pour DeepSeek</label>
        <input type="text" id="vg_template" class="text_pole" placeholder="[Description de l'image : {{caption}}]">
      </div>
    </div>
  </div>
</div>`;

function bindSettingsUi() {
    const q = (id) => document.getElementById(id);
    const enabled = q('vg_enabled');
    const auto = q('vg_auto');
    const show = q('vg_show');
    const model = q('vg_model');
    const prompt = q('vg_prompt');
    const template = q('vg_template');
    const key = q('vg_api_key');
    const saveKey = q('vg_save_key');
    if (!enabled || !auto || !show || !model || !prompt || !template || !key || !saveKey) {
        return;
    }

    enabled.checked = !!settings.enabled;
    auto.checked = !!settings.auto;
    show.checked = !!settings.showInChat;
    if (![...model.options].some((opt) => opt.value === settings.model)) {
        const extra = document.createElement('option');
        extra.value = settings.model;
        extra.textContent = settings.model;
        model.appendChild(extra);
    }
    model.value = settings.model || 'gemini-3.8-flash';
    prompt.value = settings.prompt || DEFAULT_PROMPT;
    template.value = settings.template || DEFAULT_TEMPLATE;

    enabled.addEventListener('input', () => {
        settings.enabled = enabled.checked;
        save();
    });
    auto.addEventListener('input', () => {
        settings.auto = auto.checked;
        save();
    });
    show.addEventListener('input', () => {
        settings.showInChat = show.checked;
        save();
    });
    model.addEventListener('change', () => {
        settings.model = model.value;
        save();
    });
    prompt.addEventListener('input', () => {
        settings.prompt = prompt.value;
        save();
    });
    template.addEventListener('input', () => {
        settings.template = template.value;
        save();
    });
    saveKey.addEventListener('click', async () => {
        const value = String(key.value || '').trim();
        if (!value) {
            window.toastr?.warning?.('Colle d’abord ta clé API Gemini.') || alert('Colle d’abord ta clé API Gemini.');
            return;
        }
        try {
            await saveGeminiKey(value);
            key.value = '';
            await updateKeyStatus();
            window.toastr?.success?.('Clé Gemini enregistrée.', 'Vision Gemini');
        } catch (err) {
            console.warn(LOG, err);
            window.toastr?.error?.('Impossible d’enregistrer la clé.', 'Vision Gemini');
        }
    });

    updateKeyStatus();
}

jQuery(async () => {
    loadSettings();
    window.jQuery('#extensions_settings2').append(SETTINGS_HTML);
    bindSettingsUi();

    try {
        const { eventSource, event_types } = ctx();
        eventSource.on(event_types.MESSAGE_SENT, onMessageEvent);
        if (event_types.MESSAGE_FILE_EMBEDDED) {
            eventSource.on(event_types.MESSAGE_FILE_EMBEDDED, onMessageEvent);
        }
        eventSource.on(event_types.SETTINGS_LOADED_AFTER, () => {
            loadSettings();
            updateKeyStatus();
        });
    } catch (err) {
        console.debug(LOG, 'évènements indisponibles', err);
    }
    console.log(LOG, 'chargé');
});
