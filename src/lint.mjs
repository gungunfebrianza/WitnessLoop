// Annotation linter: which forms, buttons and links in a page look like they change something and carry no
// data-wl-effect? The output is CANDIDATES, not verdicts. This is a static read of the markup: handlers wired in
// JavaScript, elements a script creates later and requests a script makes on its own are invisible to it, so a clean
// result proves nothing. The runtime observer (inject.js) and the offline detector (detect.mjs) are the other half.
import fs from 'node:fs';

const EFFECTS = ['read', 'reversible', 'irreversible']; // keep in step with registry.mjs and inject.js
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const WORDS = /\b(pay|buy|purchase|order|checkout|check out|send|submit|delete|remove|erase|destroy|transfer|withdraw|charge|confirm|approve|subscribe|unsubscribe|publish|post|cancel|log ?out|sign ?out|deploy|reset|ban)\b/i;
const HREF_WORDS = /(?:^|[/?&#=_-])(pay|buy|purchase|order|checkout|send|delete|remove|destroy|transfer|withdraw|charge|confirm|approve|unsubscribe|logout|signout|cancel|deploy|reset)(?:$|[/?&#=_.-])/i;
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const MAX_BYTES = 2 * 1024 * 1024;

export const NOTE = 'Candidates, not verdicts. This is a static read of the markup: handlers wired in JavaScript, elements a script adds later and requests a script makes on its own are invisible to it, so a clean result proves nothing.';

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

export function lintHtml(html, target = '(input)') {
  const text = String(html);
  const lineAt = (offset) => { let n = 1; for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++; return n; };
  const snippet = (from, to) => text.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 120);
  const candidates = [];
  const seen = { forms: 0, buttons: 0, links: 0 };
  let annotated = 0;
  let injected = false;
  const stack = []; // { tag, effect (nearest declared value or null), textFrom, start, attrs, inForm }
  const effective = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].effect !== null) return stack[i].effect; return null; };
  const inForm = () => stack.some((s) => s.tag === 'form' && s.candidate);
  const add = (kind, start, end, reason, extra = {}) => candidates.push({ kind, line: lineAt(start), snippet: snippet(start, end), reason, ...extra });

  const checkEffectValue = (value, start, end) => {
    if (value !== null && !EFFECTS.includes(value)) add('annotation', start, end, `unrecognised data-wl-effect "${value}": the gate treats it as irreversible (fails closed)`, { severity: 'info' });
  };

  const tokens = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!\w[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/gi;
  for (const m of text.matchAll(tokens)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1]) { // script/style: look only at the tag itself for the agent include
      if (m[1].toLowerCase() === 'script' && /\/witnessloop\/inject\.js/.test(m[0].slice(0, m[0].indexOf('>') + 1))) injected = true;
      continue;
    }
    if (m[2]) { // end tag: close the nearest matching open element
      const tag = m[2].toLowerCase();
      let k = stack.length - 1;
      while (k >= 0 && stack[k].tag !== tag) k--;
      if (k < 0) continue;
      const el = stack[k];
      stack.length = k; // an unclosed child is closed with its parent
      if (tag === 'button' || tag === 'a') {
        const label = text.slice(el.textFrom, start).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        review(el, label, end);
      }
      continue;
    }
    if (!m[3]) continue; // comment, doctype
    const tag = m[3].toLowerCase();
    const attrs = parseAttrs(m[4] ?? '');
    const own = 'data-wl-effect' in attrs ? attrs['data-wl-effect'] : null;
    if (own !== null) checkEffectValue(own, start, end);
    const el = { tag, effect: own, textFrom: end, start, attrs, end };

    if (tag === 'form') {
      seen.forms++;
      const method = (attrs.method ?? 'get').toLowerCase();
      const covered = own !== null || effective() !== null;
      if (covered) annotated++;
      else if (WRITE_METHODS.has(method)) {
        add('form', start, end, `form submits with ${method.toUpperCase()}${attrs.action ? ` to ${attrs.action.split('?')[0]}` : ''}`);
        el.candidate = true;
      } else if (attrs.action && HREF_WORDS.test(attrs.action.split('?')[0])) {
        add('form', start, end, `form action ${attrs.action.split('?')[0]} looks side-effecting`);
        el.candidate = true;
      }
    } else if (tag === 'input' && ['submit', 'button', 'image'].includes((attrs.type ?? '').toLowerCase())) {
      seen.buttons++;
      const label = attrs.value ?? attrs.alt ?? '';
      review({ ...el, tag: 'input' }, label, end);
    }
    if (!VOID.has(tag) && !m[5]) stack.push(el);
  }

  // one interactive element, once its label is known
  function review(el, label, end) {
    const covered = el.effect !== null || effective() !== null;
    if (el.tag === 'a') {
      seen.links++;
      if (!el.attrs.href) return;
      if (covered) { annotated++; return; }
      const href = el.attrs.href.split('#')[0];
      if (/^(javascript:|mailto:|tel:)/i.test(href) && !WORDS.test(label)) return;
      const why = HREF_WORDS.test(href) ? `link target ${href.split('?')[0]} looks side-effecting` : WORDS.test(label) ? `link text "${label}" looks side-effecting` : null;
      if (why) add('link', el.start, el.end, why);
      return;
    }
    seen.buttons += el.tag === 'button' ? 1 : 0;
    if (covered) { annotated++; return; }
    const type = (el.attrs.type ?? (el.tag === 'button' ? 'submit' : '')).toLowerCase();
    if (type === 'reset') return;
    if (inForm() && type === 'submit') return; // the enclosing form is already listed
    const words = [label, el.attrs.id, el.attrs.name, el.attrs['aria-label'], el.attrs.value].filter(Boolean).join(' ');
    if (WORDS.test(words)) add('button', el.start, el.end, `label looks side-effecting ("${(label || words).slice(0, 40)}")`);
  }

  const unannotated = candidates.filter((c) => c.kind !== 'annotation').length;
  return { target, scanned: { ...seen }, annotated, candidates, injected, note: NOTE, unannotatedCandidates: unannotated };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// A file, or an http(s) URL. Fetching is GET only, never follows a redirect (which could leave the allowed host) and is
// loopback-only unless the human who runs this sets WITNESSLOOP_LINT_ALLOW_REMOTE=1 in the environment: `lint-page` is also
// an MCP action, and an agent must not be able to widen it into "fetch anything from this machine".
export async function lintTarget(target, { env = process.env, fetchImpl = fetch } = {}) {
  if (!target) throw new Error('lint-page needs a file or a URL');
  if (/^https?:\/\//i.test(target)) {
    const u = new URL(target);
    if (!LOOPBACK.has(u.hostname) && env.WITNESSLOOP_LINT_ALLOW_REMOTE !== '1') {
      throw new Error(`lint-page only fetches loopback URLs (${u.hostname} is not); set WITNESSLOOP_LINT_ALLOW_REMOTE=1 in the environment to allow it`);
    }
    // a timer we clear ourselves: an AbortSignal.timeout left pending keeps the process (and a forced test exit) waiting
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let html;
    try {
      const res = await fetchImpl(target, { method: 'GET', redirect: 'manual', signal: ctl.signal });
      if (!res.ok) await res.body?.cancel().catch(() => {}); // never leave an unread body holding the socket
      if (res.status >= 300 && res.status < 400) throw new Error(`${target} redirects (${res.status}); redirects are not followed, pass the final URL`);
      if (!res.ok) throw new Error(`${target} answered ${res.status}`);
      html = await res.text();
    } finally { clearTimeout(timer); }
    if (html.length > MAX_BYTES) throw new Error(`${target} is larger than ${MAX_BYTES} bytes`);
    return lintHtml(html, target);
  }
  const size = fs.statSync(target).size;
  if (size > MAX_BYTES) throw new Error(`${target} is larger than ${MAX_BYTES} bytes`);
  return lintHtml(fs.readFileSync(target, 'utf8'), target);
}
