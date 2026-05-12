'use strict';

// ─── Token Types ─────────────────────────────────────────────────────────────
const T_CHAR      = 'char';
const T_NEWLINE   = 'newline';    // <br> within a block
const T_PARAGRAPH = 'paragraph';  // block-level break (p, div, h1-h6…)
const T_LIST_ITEM = 'list_item';  // <li> break
const T_BACKSPACE = 'backspace';  // synthetic backspace from typo correction

// ─── Logger ──────────────────────────────────────────────────────────────────
// Set window._autoTypeDebug = true in DevTools to enable the on-page debug panel.
const log  = (...a) => { console.log( '[AutoType]', ...a); DocsDebugPanel.log(a); };
const warn = (...a) => { console.warn('[AutoType]', ...a); DocsDebugPanel.log(a, 'warn'); };

// ─── Docs Debug Panel ────────────────────────────────────────────────────────
// Floating panel visible on the page when window._autoTypeDebug is truthy.
// Lets you see insertion decisions without opening DevTools.
const DocsDebugPanel = {
  _el: null,

  log(args, level = 'log') {
    if (!window._autoTypeDebug) return;
    const panel = this._panel();
    const line = document.createElement('div');
    line.style.color = level === 'warn' ? '#ff0' : '#0f0';
    line.textContent = `${new Date().toISOString().slice(11, 23)} ${args.map(String).join(' ')}`;
    panel.appendChild(line);
    while (panel.children.length > 60) panel.removeChild(panel.firstChild);
    panel.scrollTop = panel.scrollHeight;
  },

  _panel() {
    if (this._el && document.body.contains(this._el)) return this._el;
    const el = document.createElement('div');
    el.id = 'autotype-debug-panel';
    Object.assign(el.style, {
      position: 'fixed', top: '0', right: '0', width: '440px', maxHeight: '280px',
      overflow: 'auto', background: 'rgba(0,0,0,0.88)', color: '#0f0',
      fontFamily: 'monospace', fontSize: '11px', padding: '8px',
      zIndex: '2147483647', borderBottomLeftRadius: '6px', whiteSpace: 'pre-wrap',
      wordBreak: 'break-all', lineHeight: '1.5',
    });
    document.body.appendChild(el);
    return (this._el = el);
  },
};

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

// ─────────────────────────────────────────────────────────────────────────────
// GoogleDocsStrategy
//
// Google Docs does NOT use a visible contenteditable for text entry.  It focuses
// a hidden <iframe class="docs-texteventtarget-iframe"> whose inner document
// contains the real input sink.  All keyboard events must be dispatched to the
// element inside that iframe; execCommand does NOT affect the Docs document model.
//
// Event pipeline per character:  keydown → beforeinput → keypress → input → keyup
// beforeinput with inputType='insertText' is Docs' primary trigger for inserting text.
// ─────────────────────────────────────────────────────────────────────────────
class GoogleDocsStrategy extends InsertionStrategy {

  // ── Input-sink discovery ─────────────────────────────────────────────────
  // Returns { element, doc } or null.  Tries sources in priority order.
  _findInputSink() {
    // 1. Primary: the dedicated Docs event-capture iframe
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (iframe) {
      try {
        const iDoc = iframe.contentDocument;
        if (iDoc) {
          // Use whichever element is already focused inside the iframe first
          const iAE = iDoc.activeElement;
          if (iAE && iAE !== iDoc.body && iAE !== iDoc.documentElement) {
            log('Sink: iframe.activeElement →', iAE.tagName, iAE.className?.slice(0, 50));
            return { element: iAE, doc: iDoc };
          }
          // Fall back to the first contenteditable inside the iframe
          const editable = iDoc.querySelector('[contenteditable]');
          if (editable) {
            log('Sink: iframe[contenteditable] →', editable.tagName, editable.className?.slice(0, 50));
            return { element: editable, doc: iDoc };
          }
          // Last resort: iframe body itself (Docs sometimes makes body editable)
          log('Sink: iframe body (no contenteditable found inside iframe)');
          return { element: iDoc.body, doc: iDoc };
        }
      } catch (e) {
        warn('Cannot access iframe document:', e.message);
      }
    }

    // 2. Selection anchor — most reliable signal of where text will land
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode) {
      const anchor = sel.anchorNode;
      const anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
      const editable = anchorEl?.closest('[contenteditable="true"]');
      if (editable) {
        log('Sink: selection anchor →', editable.tagName, editable.className?.slice(0, 50));
        return { element: editable, doc: document };
      }
    }

    // 3. document.activeElement in current frame (works when script runs inside the iframe)
    const ae = document.activeElement;
    if (ae && ae.isContentEditable) {
      log('Sink: document.activeElement (contenteditable) →', ae.tagName, ae.className?.slice(0, 50));
      return { element: ae, doc: document };
    }

    warn('Sink: none found — dumping diagnostics');
    this.logDiagnostics();
    return null;
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────
  logDiagnostics() {
    log('=== DOCS DIAGNOSTICS ===');
    log('document.activeElement:', document.activeElement?.tagName, document.activeElement?.className?.slice(0, 70));

    const sel = window.getSelection();
    if (sel) {
      log('Selection rangeCount:', sel.rangeCount, '| collapsed:', sel.isCollapsed);
      if (sel.anchorNode) log('  anchor:', sel.anchorNode.nodeName, JSON.stringify(sel.anchorNode.textContent?.slice(0, 30)));
      if (sel.focusNode)  log('  focus: ', sel.focusNode.nodeName,  JSON.stringify(sel.focusNode.textContent?.slice(0, 30)));
    }

    const allCE = [...document.querySelectorAll('[contenteditable]')];
    log(`Main-doc contenteditable count: ${allCE.length}`);
    allCE.slice(0, 5).forEach((el, i) =>
      log(`  [${i}]`, el.tagName, el.className?.slice(0, 50), '| isFocused:', el === document.activeElement)
    );

    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    log('docs-texteventtarget-iframe present:', !!iframe);
    if (iframe) {
      try {
        const iDoc = iframe.contentDocument;
        log('  iframe.activeElement:', iDoc.activeElement?.tagName, iDoc.activeElement?.className?.slice(0, 50));
        const iCE = [...iDoc.querySelectorAll('[contenteditable]')];
        log(`  iframe contenteditable count: ${iCE.length}`);
        iCE.slice(0, 3).forEach((el, i) =>
          log(`    [${i}]`, el.tagName, el.className?.slice(0, 50))
        );
      } catch (e) { log('  Cannot access iframe:', e.message); }
    }
    log('=== END DIAGNOSTICS ===');
  }

  // ── verifyTarget ─────────────────────────────────────────────────────────
  // For Docs the "target" concept is the iframe structure, not a specific element.
  verifyTarget(_el) {
    // Accept as long as we can still find an input sink
    const sink = this._findInputSink();
    if (!sink) {
      warn('verifyTarget: input sink gone');
      return false;
    }
    return true;
  }

  // ── insert ───────────────────────────────────────────────────────────────
  insert(token, _fallbackEl) {
    const sink = this._findInputSink();
    if (!sink) return false;
    const { element, doc } = sink;

    log(`insert type=${token.type} char=${JSON.stringify(token.char || '')} → ${element.tagName} in ${doc === document ? 'main' : 'iframe'} doc`);

    if (doc.activeElement !== element) {
      element.focus();
      log('Refocused element before insert');
    }

    const selBefore = this._selectionOffset(doc);

    if (token.type === T_CHAR) {
      this._dispatchChar(token.char, element);
    } else {
      this._dispatchEnter(element);
    }

    // Verify: selection should have advanced (or at least not regressed)
    const selAfter = this._selectionOffset(doc);
    if (selAfter !== null && selBefore !== null && selAfter <= selBefore) {
      warn(`Insertion may have failed: selection offset ${selBefore} → ${selAfter} for char "${token.char || ''}"`);
    }

    return true;
  }

  // ── backspace ────────────────────────────────────────────────────────────
  backspace(_el) {
    const sink = this._findInputSink();
    if (!sink) return;
    const { element } = sink;
    this._dispatchKey('Backspace', 'Backspace', 8, element, 'deleteContentBackward');
  }

  // ── Keyboard pipeline helpers ────────────────────────────────────────────
  _dispatchChar(char, el) {
    const charCode  = char.charCodeAt(0);
    const upperCode = char.toUpperCase().charCodeAt(0);
    const code      = this._charToCode(char);
    const shifted   = char !== char.toLowerCase() || '!@#$%^&*()_+{}|:"<>?~'.includes(char);
    const base = { bubbles: true, composed: true };

    el.dispatchEvent(new KeyboardEvent('keydown', {
      ...base, cancelable: true, key: char, code,
      keyCode: upperCode, charCode: 0, which: upperCode, shiftKey: shifted,
    }));

    const bi = new InputEvent('beforeinput', {
      ...base, cancelable: true, inputType: 'insertText', data: char,
    });
    const notPrevented = el.dispatchEvent(bi);
    log(`  beforeinput notPrevented=${notPrevented}`);

    el.dispatchEvent(new KeyboardEvent('keypress', {
      ...base, cancelable: true, key: char, code,
      keyCode: charCode, charCode: charCode, which: charCode, shiftKey: shifted,
    }));

    el.dispatchEvent(new InputEvent('input', {
      ...base, inputType: 'insertText', data: char,
    }));

    el.dispatchEvent(new KeyboardEvent('keyup', {
      ...base, key: char, code,
      keyCode: upperCode, charCode: 0, which: upperCode, shiftKey: shifted,
    }));
  }

  _dispatchEnter(el) {
    this._dispatchKey('Enter', 'Enter', 13, el, 'insertParagraph');
  }

  _dispatchKey(key, code, keyCode, el, inputType) {
    const base = { bubbles: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown',  { ...base, cancelable: true, key, code, keyCode, charCode: 0, which: keyCode }));
    el.dispatchEvent(new InputEvent('beforeinput', { ...base, cancelable: true, inputType }));
    el.dispatchEvent(new InputEvent('input',       { ...base, inputType }));
    el.dispatchEvent(new KeyboardEvent('keyup',    { ...base, key, code, keyCode, charCode: 0, which: keyCode }));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  _selectionOffset(doc) {
    try {
      const sel = doc.getSelection ? doc.getSelection() : window.getSelection();
      if (sel && sel.rangeCount) return sel.getRangeAt(0).startOffset;
    } catch (_) {}
    return null;
  }

  _charToCode(char) {
    const lower = char.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return `Key${lower.toUpperCase()}`;
    if (char >= '0' && char <= '9')   return `Digit${char}`;
    return {
      ' ': 'Space', '.': 'Period',  ',': 'Comma',   '-': 'Minus',
      '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
      ';': 'Semicolon', "'": 'Quote', '/': 'Slash',
      '\\': 'Backslash', '`': 'Backquote',
    }[char] || '';
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

  if (isGoogleDocs()) {
    // When Docs is focused, activeElement is often the docs-texteventtarget-iframe itself.
    // Drill into it to get the actual editable sink, or just pass a sentinel — the
    // GoogleDocsStrategy will locate the real sink via _findInputSink() anyway.
    if (target && target.tagName === 'IFRAME') {
      try {
        const inner = target.contentDocument?.activeElement;
        if (inner && inner !== target.contentDocument.body) target = inner;
      } catch (_) {}
    }
    // Even if target is still the iframe or body, proceed: strategy handles discovery.
    log('Docs paste: activeElement =', target?.tagName, target?.className?.slice(0, 50));
  } else {
    if (!isTypable(target)) return;
  }

  e.preventDefault();
  e.stopPropagation();

  if (autoTyper.isRunning()) autoTyper.abort();

  const htmlData = e.clipboardData.getData('text/html');
  const textData = e.clipboardData.getData('text/plain');

  let tokens;
  if (htmlData && (isGoogleDocs() || target?.isContentEditable)) {
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

// ─── Dev helpers (accessible from DevTools console) ──────────────────────────
// window._autoTypeDebug = true   — enable on-page debug panel + verbose logging
// window._autoTypeDiag()         — dump full Docs input-sink diagnostics to console
// window._autoTypeDebug = false  — hide debug panel
window._autoTypeDiag = () => {
  window._autoTypeDebug = true;
  if (isGoogleDocs()) {
    log('Running Docs diagnostics…');
    new GoogleDocsStrategy().logDiagnostics();
  } else {
    log('Not on Google Docs');
    log('activeElement:', document.activeElement?.tagName, document.activeElement?.className?.slice(0, 70));
    log('All contenteditable:', [...document.querySelectorAll('[contenteditable]')].map(el => `${el.tagName}.${el.className?.slice(0,30)}`));
  }
};
