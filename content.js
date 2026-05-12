'use strict';

// ─── Token Types ─────────────────────────────────────────────────────────────
const T_CHAR      = 'char';
const T_NEWLINE   = 'newline';    // <br> within a block
const T_PARAGRAPH = 'paragraph';  // block-level break (p, div, h1-h6…)
const T_LIST_ITEM = 'list_item';  // <li> break
const T_BACKSPACE = 'backspace';  // synthetic backspace from typo correction

// ─── Logger ──────────────────────────────────────────────────────────────────
const log  = (...a) => console.log( '[AutoType]', ...a);
const warn = (...a) => console.warn('[AutoType]', ...a);

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  const prev = document.getElementById('autotype-toast');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.id = 'autotype-toast';
  el.className = 'autotype-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  void el.offsetWidth; // force reflow to start transition
  el.classList.add('autotype-toast--visible');
  setTimeout(() => {
    el.classList.remove('autotype-toast--visible');
    setTimeout(() => el.remove(), 300);
  }, 2000);
}

// ─── HTML → Token Parser ──────────────────────────────────────────────────────
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
]);

function parseHtmlToTokens(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tokens = [];
  walkNode(doc.body, {}, tokens);
  // Trim leading/trailing structural tokens so we don't start with a newline
  while (tokens.length && tokens[0].type !== T_CHAR) tokens.shift();
  while (tokens.length && tokens[tokens.length - 1].type !== T_CHAR) tokens.pop();
  return tokens;
}

function walkNode(node, styles, tokens) {
  if (node.nodeType === Node.TEXT_NODE) {
    // Use string iterator to handle multi-codepoint Unicode (emoji, etc.) correctly
    for (const char of node.textContent) {
      if (char === '\r' || char === '\n') continue; // raw source newlines, not semantic
      tokens.push({ type: T_CHAR, char, styles: { ...styles } });
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.nodeName;
  const merged = mergeStyles(node, styles);

  if (tag === 'BR') {
    tokens.push({ type: T_NEWLINE, styles: { ...merged } });
    return;
  }
  if (tag === 'LI') {
    if (tokens.length) tokens.push({ type: T_LIST_ITEM, styles: { ...merged } });
    for (const child of node.childNodes) walkNode(child, merged, tokens);
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    // Add paragraph break before block content (not before the very first token)
    if (tokens.length) tokens.push({ type: T_PARAGRAPH, styles: { ...merged } });
    for (const child of node.childNodes) walkNode(child, merged, tokens);
    return;
  }

  for (const child of node.childNodes) walkNode(child, merged, tokens);
}

function mergeStyles(el, inherited) {
  const s = { ...inherited };
  const tag = el.nodeName;

  // Semantic tags
  if (tag === 'B' || tag === 'STRONG') s.bold = true;
  if (tag === 'I' || tag === 'EM')     s.italic = true;
  if (tag === 'U')                     s.underline = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.strikethrough = true;

  // Inline style attributes
  const cs = el.style;
  if (cs) {
    const fw = cs.fontWeight;
    if (fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 700) s.bold = true;
    if (cs.fontStyle === 'italic') s.italic = true;
    const td = cs.textDecoration || '';
    if (td.includes('underline'))    s.underline = true;
    if (td.includes('line-through')) s.strikethrough = true;
    if (cs.color)      s.color      = cs.color;
    if (cs.fontSize)   s.fontSize   = cs.fontSize;
    if (cs.fontFamily) s.fontFamily = cs.fontFamily;
  }
  return s;
}

// ─── Token → HTML ─────────────────────────────────────────────────────────────
function escapeHtml(c) {
  return c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildStyleString(styles) {
  const f = [];
  if (styles.bold)   f.push('font-weight:bold');
  if (styles.italic) f.push('font-style:italic');
  if (styles.underline && styles.strikethrough) f.push('text-decoration:underline line-through');
  else if (styles.underline)    f.push('text-decoration:underline');
  else if (styles.strikethrough) f.push('text-decoration:line-through');
  if (styles.color)      f.push(`color:${styles.color}`);
  if (styles.fontSize)   f.push(`font-size:${styles.fontSize}`);
  if (styles.fontFamily) f.push(`font-family:${styles.fontFamily}`);
  return f.join(';');
}

function tokenToHtml(token) {
  const inner = escapeHtml(token.char);
  const style = buildStyleString(token.styles || {});
  return style ? `<span style="${style}">${inner}</span>` : inner;
}

// ─── Editor Detection ─────────────────────────────────────────────────────────
function isGoogleDocs() {
  return /docs\.google\.com/.test(window.location.hostname);
}

function detectStrategy(element) {
  if (isGoogleDocs()) {
    log('Strategy selected: GoogleDocs');
    return new GoogleDocsStrategy();
  }
  if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) {
    log('Strategy selected: PlainText');
    return new PlainTextStrategy();
  }
  if (element && element.isContentEditable) {
    log('Strategy selected: GenericContentEditable');
    return new GenericContentEditableStrategy();
  }
  warn('No strategy matched for element', element);
  return null;
}

// ─── Insertion Strategies ─────────────────────────────────────────────────────

class InsertionStrategy {
  verifyTarget(el) {
    if (!el || !document.contains(el)) {
      warn('Target element is no longer in the DOM');
      return false;
    }
    return true;
  }
  // eslint-disable-next-line no-unused-vars
  insert(_token, _el) { throw new Error('insert() not implemented'); }
  backspace(_el) { document.execCommand('delete', false, null); }
}

// Google Docs: fire realistic keyboard + InputEvent pipeline, then execCommand for actual insertion.
// Docs listens to beforeinput with inputType='insertText' and updates its own model accordingly;
// the execCommand call keeps the visible contenteditable in sync.
class GoogleDocsStrategy extends InsertionStrategy {
  insert(token, el) {
    const editor = this._findEditor(el);
    if (!this.verifyTarget(editor)) return false;

    if (token.type === T_CHAR) {
      this._simulateChar(token.char, editor, token.styles);
    } else {
      this._simulateEnter(editor);
    }
    return true;
  }

  _findEditor(fallback) {
    // Prefer the specific Docs editor class; fall back to any contenteditable on the page.
    return (
      document.querySelector('.kix-appview-editor[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]') ||
      fallback
    );
  }

  _simulateChar(char, el, styles) {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: char, bubbles: true, cancelable: true, composed: true,
    }));
    // beforeinput signals the intent to insert; Docs updates its internal model here
    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: char,
      bubbles: true, cancelable: true, composed: true,
    }));
    // execCommand performs the visible DOM insertion
    const html = styles && Object.keys(styles).some(k => styles[k]) ? tokenToHtml({ char, styles }) : escapeHtml(char);
    document.execCommand('insertHTML', false, html);
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: char,
      bubbles: true, composed: true,
    }));
    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: char, bubbles: true, composed: true,
    }));
  }

  _simulateEnter(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, cancelable: true, composed: true,
    }));
    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true, cancelable: true, composed: true,
    }));
    document.execCommand('insertParagraph', false, null);
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertParagraph', bubbles: true, composed: true,
    }));
    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, composed: true,
    }));
  }

  backspace(el) {
    const editor = this._findEditor(el);
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', keyCode: 8,
      bubbles: true, cancelable: true, composed: true,
    }));
    editor.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true, cancelable: true, composed: true,
    }));
    document.execCommand('delete', false, null);
    editor.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward', bubbles: true, composed: true,
    }));
    editor.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Backspace', code: 'Backspace', keyCode: 8,
      bubbles: true, composed: true,
    }));
  }
}

// Plain text: direct value manipulation + synthetic InputEvent for framework compatibility.
class PlainTextStrategy extends InsertionStrategy {
  insert(token, el) {
    if (!this.verifyTarget(el)) return false;
    const isMultiLine = el.tagName === 'TEXTAREA';

    let char;
    if (token.type === T_CHAR) {
      char = token.char;
    } else if (isMultiLine) {
      char = '\n'; // allow newlines in textareas
    } else {
      return true; // skip structural tokens in single-line inputs
    }

    const start = el.selectionStart;
    const end   = el.selectionEnd;
    el.value = el.value.slice(0, start) + char + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + 1;
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: char,
      bubbles: true, cancelable: true,
    }));
    return true;
  }

  backspace(el) {
    if (!this.verifyTarget(el)) return;
    const start = el.selectionStart;
    if (start === 0) return;
    el.value = el.value.slice(0, start - 1) + el.value.slice(start);
    el.selectionStart = el.selectionEnd = start - 1;
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward',
      bubbles: true, cancelable: true,
    }));
  }
}

// Generic contenteditable: execCommand only, no extra event simulation.
class GenericContentEditableStrategy extends InsertionStrategy {
  insert(token, el) {
    if (!this.verifyTarget(el) || !el.isContentEditable) return false;

    if (token.type === T_NEWLINE) {
      document.execCommand('insertHTML', false, '<br>');
    } else if (token.type === T_PARAGRAPH || token.type === T_LIST_ITEM) {
      document.execCommand('insertParagraph', false, null);
    } else {
      document.execCommand('insertHTML', false, tokenToHtml(token));
    }
    return true;
  }
}

// ─── Humanized Timer ──────────────────────────────────────────────────────────
// Produces variable per-character delays that mimic real human typing:
//   • Short bursts of fast characters separated by micro-pauses
//   • Longer pauses after punctuation and line breaks
//   • Random jitter on every delay
class HumanizedTimer {
  constructor(baseMs) {
    this.base      = baseMs;
    this.burstCount = 0;
    this.burstMax   = this._nextBurstMax();
  }

  nextDelay(token) {
    if (!token) return this.base;
    const char = token.char || '';

    // Structural breaks — simulate the writer thinking/formatting
    if (token.type === T_PARAGRAPH) return this.base * 5  + this._jitter(150);
    if (token.type === T_NEWLINE || token.type === T_LIST_ITEM) return this.base * 3 + this._jitter(80);
    // Slow down after strong punctuation
    if ('.!?'.includes(char))  return this.base * 4 + this._jitter(100);
    if (',;:'.includes(char))  return this.base * 2 + this._jitter(50);
    // Backspace during typo correction — slightly faster than normal typing
    if (token.type === T_BACKSPACE) return this.base * 1.2 + this._jitter(20);

    // Burst behaviour: type a cluster of chars quickly, then pause
    if (this.burstCount >= this.burstMax) {
      this.burstCount = 0;
      this.burstMax   = this._nextBurstMax();
      return this.base * 3 + this._jitter(180); // inter-burst pause
    }
    this.burstCount++;
    return Math.max(10, this.base + this._jitter(this.base * 0.45));
  }

  _jitter(range) { return (Math.random() - 0.5) * range * 2; }
  _nextBurstMax() { return 3 + Math.floor(Math.random() * 8); } // 3–10 chars per burst
}

// ─── Typo Simulator ───────────────────────────────────────────────────────────
// Injects occasional adjacent-key mistakes followed by an immediate backspace correction.
const NEARBY_KEYS = {
  a:'sq', b:'vn', c:'xv', d:'sf', e:'wr', f:'dg', g:'fh', h:'gj',
  i:'uo', j:'hk', k:'jl', l:'k',  m:'n',  n:'bm', o:'ip', p:'o',
  q:'wa', r:'et', s:'ad', t:'ry', u:'yi', v:'cb', w:'qe', x:'zc',
  y:'tu', z:'x',
};

class TypoSimulator {
  constructor(rate = 0.02) { this.rate = rate; }

  inject(tokens) {
    const out = [];
    for (const token of tokens) {
      if (token.type !== T_CHAR || Math.random() > this.rate) {
        out.push(token);
        continue;
      }
      const wrong = this._nearbyKey(token.char);
      if (!wrong) { out.push(token); continue; }
      // Type wrong character, then backspace, then the correct one
      out.push({ type: T_CHAR,      char: wrong, styles: token.styles });
      out.push({ type: T_BACKSPACE, styles: {} });
      out.push(token);
    }
    return out;
  }

  _nearbyKey(char) {
    const neighbors = NEARBY_KEYS[char.toLowerCase()];
    if (!neighbors) return null;
    return neighbors[Math.floor(Math.random() * neighbors.length)];
  }
}

// ─── AutoTyper ────────────────────────────────────────────────────────────────
// Each call to start() creates a new Symbol session ID.  Every scheduled timer
// carries that ID and silently exits if the ID no longer matches — preventing
// zombie timers from a previous session that was aborted or restarted.
class AutoTyper {
  constructor() {
    this.sessionId = null; // Symbol | null
    this.tokens    = [];
    this.index     = 0;
    this.paused    = false;
    this.targetEl  = null;
    this.strategy  = null;
    this.timer     = null;
    this.timerId   = null;
  }

  start(tokens, targetEl, speed, enableTypos) {
    this._cancelSession();

    const processed = enableTypos ? new TypoSimulator().inject(tokens) : tokens;
    this.tokens   = processed;
    this.index    = 0;
    this.paused   = false;
    this.targetEl = targetEl;
    this.timer    = new HumanizedTimer(speed);
    this.strategy = detectStrategy(targetEl);

    if (!this.strategy) {
      showToast('AutoType: unsupported field');
      return;
    }

    const id = Symbol('session');
    this.sessionId = id;
    log(`Session started | strategy: ${this.strategy.constructor.name} | tokens: ${this.tokens.length} | speed: ${speed}ms`);
    showToast('AutoType: TYPING…');
    this._schedule(id);
  }

  _schedule(id) {
    if (this.sessionId !== id) { log('Stale schedule call ignored'); return; }
    if (this.paused) return;
    if (this.index >= this.tokens.length) {
      log('Session completed');
      showToast('AutoType: Done ✓');
      this.sessionId = null;
      return;
    }
    const delay = this.timer.nextDelay(this.tokens[this.index]);
    this.timerId = setTimeout(() => this._tick(id), delay);
  }

  _tick(id) {
    if (this.sessionId !== id) { log('Zombie timer discarded'); return; }

    const token = this.tokens[this.index++];

    // Abort if the target field has disappeared or focus has moved away
    if (!this.strategy.verifyTarget(this.targetEl)) {
      log('Target lost — aborting session');
      showToast('AutoType: focus lost');
      this.sessionId = null;
      return;
    }

    if (token.type === T_BACKSPACE) {
      this.strategy.backspace(this.targetEl);
    } else {
      this.strategy.insert(token, this.targetEl);
    }

    this._schedule(id);
  }

  _cancelSession() {
    if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
    if (this.sessionId) log(`Session ${String(this.sessionId)} cancelled`);
    this.sessionId = null;
  }

  pause() {
    if (!this.isRunning()) return;
    this.paused = true;
    if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
    log('Session paused');
    showToast('AutoType: PAUSED');
  }

  resume() {
    if (!this.paused || !this.sessionId) return;
    this.paused = false;
    log('Session resumed');
    showToast('AutoType: RESUMED');
    this._schedule(this.sessionId);
  }

  togglePause() { this.paused ? this.resume() : this.pause(); }

  abort() {
    const hadSession = !!this.sessionId;
    this._cancelSession();
    this.paused = false;
    if (hadSession) { log('Session aborted by user'); showToast('AutoType: ABORTED'); }
  }

  isRunning() { return !!this.sessionId; }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
let extensionEnabled = true;
let typingSpeed      = 50;
let enableTypos      = false;

const autoTyper = new AutoTyper();

// Load persisted state; default to enabled until the async response arrives
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (chrome.runtime.lastError) return;
  if (!state) return;
  extensionEnabled = state.enabled ?? true;
  typingSpeed      = state.speed   ?? 50;
  enableTypos      = state.typos   ?? false;
  log(`State loaded: enabled=${extensionEnabled} speed=${typingSpeed} typos=${enableTypos}`);
});

// Sync state changes written by the popup without requiring tab enumeration
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) extensionEnabled = changes.enabled.newValue;
  if (changes.speed)   typingSpeed      = changes.speed.newValue;
  if (changes.typos)   enableTypos      = changes.typos.newValue;
});

function isTypable(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

// ─── Paste interception ───────────────────────────────────────────────────────
document.addEventListener('paste', (e) => {
  if (!extensionEnabled) return;

  let target = document.activeElement;

  // Google Docs may not report the editor as activeElement; locate it explicitly
  if (isGoogleDocs() && !isTypable(target)) {
    const docsEditor = document.querySelector('[contenteditable="true"]');
    if (docsEditor) target = docsEditor;
  }

  if (!isTypable(target)) return;

  e.preventDefault();
  e.stopPropagation();

  if (autoTyper.isRunning()) autoTyper.abort();

  const htmlData = e.clipboardData.getData('text/html');
  const textData = e.clipboardData.getData('text/plain');

  let tokens;
  if (htmlData && (target.isContentEditable || isGoogleDocs())) {
    tokens = parseHtmlToTokens(htmlData);
    log(`HTML clipboard parsed → ${tokens.length} tokens`);
  } else {
    tokens = Array.from(textData).map(char => ({ type: T_CHAR, char, styles: {} }));
    log(`Plain text clipboard parsed → ${tokens.length} chars`);
  }

  if (!tokens.length) return;
  autoTyper.start(tokens, target, typingSpeed, enableTypos);
}, { capture: true });

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Shift+K — pause / resume active session
  if (e.shiftKey && e.key === 'K' && autoTyper.isRunning()) {
    e.preventDefault();
    e.stopPropagation();
    autoTyper.togglePause();
    return;
  }
  // Shift+Esc — abort active session
  if (e.shiftKey && e.key === 'Escape' && autoTyper.isRunning()) {
    e.preventDefault();
    e.stopPropagation();
    autoTyper.abort();
    return;
  }
  // Shift+Enter — toggle extension on/off (always intercepted)
  if (e.shiftKey && e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED' }, (resp) => {
      if (chrome.runtime.lastError) return;
      extensionEnabled = resp.enabled;
      log(`Extension toggled → ${extensionEnabled ? 'ON' : 'OFF'}`);
      showToast(`AutoType: ${extensionEnabled ? 'ON' : 'OFF'}`);
    });
  }
}, { capture: true });
