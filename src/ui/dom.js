/**
 * Tiny DOM helpers.
 *
 * No framework, no build step. Everything the popup draws goes through `el()`
 * and `render()`, so no UI code ever touches `innerHTML` and no name taken off
 * a LinkedIn page is ever parsed as markup.
 */

const ATTR_ONLY = new Set(['class', 'for', 'role', 'list']);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.nodeType !== 'number'
  );
}

function applyAttr(node, key, value) {
  if (value === null || value === undefined || value === false) return;

  if (key === 'class' || key === 'className') {
    node.setAttribute('class', String(value));
    return;
  }
  if (key === 'text') {
    node.textContent = String(value);
    return;
  }
  if (key === 'style' && isPlainObject(value)) {
    Object.assign(node.style, value);
    return;
  }
  if (key.startsWith('on') && typeof value === 'function') {
    node.addEventListener(key.slice(2).toLowerCase(), value);
    return;
  }
  if (!ATTR_ONLY.has(key) && key in node) {
    node[key] = value;
    return;
  }
  node.setAttribute(key, value === true ? '' : String(value));
}

function appendChild(node, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(node, item);
    return;
  }
  if (typeof child.nodeType === 'number') {
    node.appendChild(child);
    return;
  }
  node.appendChild(document.createTextNode(String(child)));
}

/**
 * Create an element.
 *
 *   el('div', { class: 'card' }, el('h2', 'Title'), 'text')
 *   el('button', { onclick: fn, disabled: true }, 'Run')
 *
 * The second argument is treated as an attribute bag only when it is a plain
 * object; anything else becomes the first child.
 *
 * @param {string} tag
 * @param {object|Node|string|number|Array|null} [attrs]
 * @param {...*} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  let bag = attrs;
  if (!isPlainObject(bag)) {
    if (bag !== undefined) children.unshift(bag);
    bag = null;
  }
  if (bag) for (const [key, value] of Object.entries(bag)) applyAttr(node, key, value);
  for (const child of children) appendChild(node, child);
  return node;
}

/**
 * Replace everything inside `container` with `nodes`.
 * @param {HTMLElement} container
 * @param {*} nodes node, string, or (nested) array of them
 * @returns {HTMLElement} container
 */
export function render(container, nodes) {
  if (!container) return container;
  container.textContent = '';
  appendChild(container, nodes);
  return container;
}

/** Format a number with thousands separators. Non-numbers become an em dash. */
export function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString();
}
