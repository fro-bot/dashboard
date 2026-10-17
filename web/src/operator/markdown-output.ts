/**
 * Renders run output (untrusted model text) as Markdown into a DocumentFragment.
 *
 * Output is built from parser tokens only. Every element comes from a fixed allowlist, is
 * created with the passed document's createElement, and carries text through text nodes. No
 * HTML string is built or parsed anywhere, so there is nothing to sanitize: raw HTML in the
 * input is plain text (the parser's html option is off).
 */

import type {Token} from 'markdown-it'
import MarkdownIt from 'markdown-it'

/** Created nodes (elements and text) allowed per render; past this the render throws. */
export const MAX_OUTPUT_NODES = 20_000

const MAX_HREF_LENGTH = 2048
const TABLE_WRAPPER_CLASS = 'run-output-table'
const LINK_HOST_CLASS = 'run-output-link-host'
const MIN_HEADING_LEVEL = 4
const MAX_HEADING_LEVEL = 6
// markdown-it only recognizes ordered-list numbers of up to nine digits.
const ORDERED_START = /^[1-9]\d{0,8}$/

export const markdownIt = new MarkdownIt({html: false, linkify: true, typographer: false})
// Only scheme-prefixed URLs are linkified. Bare "README.md" or "example.com" are not links.
markdownIt.linkify.set({fuzzyLink: false, fuzzyEmail: false})

export interface RenderOptions {
  readonly doc: Document
  /** The page origin. Links to it are rejected so output cannot target the operator's own routes. */
  readonly origin: string
}

interface Frame {
  readonly node: Node
  /** Appended to the parent when the frame closes, after the element it belongs to. */
  readonly after?: () => Node
}

interface State {
  readonly doc: Document
  readonly pageOrigin: string
  readonly stack: Frame[]
  nodes: number
}

function spend(state: State): void {
  state.nodes += 1
  if (state.nodes > MAX_OUTPUT_NODES) throw new Error('output exceeds the rendered node limit')
}

function createElement(state: State, tag: string): HTMLElement {
  spend(state)
  return state.doc.createElement(tag)
}

function createText(state: State, data: string): Text {
  spend(state)
  return state.doc.createTextNode(data)
}

function appendText(state: State, parent: Node, data: string): void {
  if (data !== '') parent.appendChild(createText(state, data))
}

function currentNode(state: State): Node {
  const frame = state.stack.at(-1)
  if (frame === undefined) throw new Error('renderer stack is empty')
  return frame.node
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin
  } catch {
    return origin
  }
}

/** The parsed URL if the policy allows an anchor for it, otherwise null. */
function acceptLink(href: string, pageOrigin: string): URL | null {
  if (href.length > MAX_HREF_LENGTH) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.href.length > MAX_HREF_LENGTH) return null
  if (url.origin === pageOrigin) return null
  return url
}

/** The visible text of a link: the inline tokens between its open token and the next close. */
function linkLabel(tokens: readonly Token[], openIndex: number): string {
  let label = ''
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined || token.type === 'link_close') break
    if (token.type === 'image') label += token.content === '' ? '[image]' : token.content
    else if (token.type === 'softbreak' || token.type === 'hardbreak') label += ' '
    else if (token.nesting === 0) label += token.content
  }
  return label
}

function labelIsUrl(label: string, url: URL): boolean {
  try {
    return new URL(label.trim()).href === url.href
  } catch {
    return false
  }
}

/** Whether the host a label shows is written with non-ASCII characters. The label is the text as typed. */
function labelHostIsNonAscii(label: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(label.trim())?.[1] ?? ''
  return /[^\u0000-\u007F]/.test(authority)
}

/** The muted `(host)` that follows an anchor; `url.hostname` is the punycode form. */
function hostSuffix(state: State, url: URL): Frame['after'] {
  return () => {
    const host = createElement(state, 'span')
    host.setAttribute('class', LINK_HOST_CLASS)
    appendText(state, host, ` (${url.hostname})`)
    return host
  }
}

function openLink(state: State, tokens: readonly Token[], index: number, token: Token): Frame {
  const parent = currentNode(state)
  const href = String(token.attrGet('href') ?? '')
  const label = linkLabel(tokens, index)
  // Autolinks and linkified bare URLs display the destination itself.
  const showsDestination = token.markup === 'linkify' || token.markup === 'autolink'
  const url = acceptLink(href, state.pageOrigin)

  if (url === null) {
    if (showsDestination || label === href) return {node: parent}
    return {node: parent, after: () => createText(state, ` (${href})`)}
  }

  const anchor = createElement(state, 'a')
  anchor.setAttribute('href', url.href)
  anchor.setAttribute('target', '_blank')
  anchor.setAttribute('rel', 'noopener noreferrer')
  parent.appendChild(anchor)
  // A link that shows its own URL needs no host, unless the host it shows is non-ASCII: then the
  // punycode form is the host the browser will contact.
  if (showsDestination || labelIsUrl(label, url)) {
    return labelHostIsNonAscii(label) ? {node: anchor, after: hostSuffix(state, url)} : {node: anchor}
  }
  return {node: anchor, after: hostSuffix(state, url)}
}

function headingTag(token: Token): string {
  const level = Number(token.tag.slice(1))
  if (!Number.isInteger(level)) return `h${MIN_HEADING_LEVEL}`
  return `h${Math.min(MAX_HEADING_LEVEL, Math.max(MIN_HEADING_LEVEL, level))}`
}

function openElement(state: State, tag: string): Frame {
  const el = createElement(state, tag)
  currentNode(state).appendChild(el)
  return {node: el}
}

/** The frame for an opening token. Tokens outside the allowlist add no element of their own. */
function openFrame(state: State, tokens: readonly Token[], index: number, token: Token): Frame {
  switch (token.type) {
    case 'heading_open':
      return openElement(state, headingTag(token))
    case 'paragraph_open':
      // Tight-list paragraphs are hidden: their content sits directly in the list item.
      return token.hidden ? {node: currentNode(state)} : openElement(state, 'p')
    case 'bullet_list_open':
      return openElement(state, 'ul')
    case 'ordered_list_open': {
      const list = createElement(state, 'ol')
      const start = String(token.attrGet('start') ?? '')
      if (ORDERED_START.test(start)) list.setAttribute('start', start)
      currentNode(state).appendChild(list)
      return {node: list}
    }
    case 'list_item_open':
      return openElement(state, 'li')
    case 'blockquote_open':
      return openElement(state, 'blockquote')
    case 'table_open': {
      const wrapper = createElement(state, 'div')
      wrapper.setAttribute('class', TABLE_WRAPPER_CLASS)
      currentNode(state).appendChild(wrapper)
      const table = createElement(state, 'table')
      wrapper.appendChild(table)
      return {node: table}
    }
    case 'thead_open':
      return openElement(state, 'thead')
    case 'tbody_open':
      return openElement(state, 'tbody')
    case 'tr_open':
      return openElement(state, 'tr')
    case 'th_open':
      return openElement(state, 'th')
    case 'td_open':
      return openElement(state, 'td')
    case 'em_open':
      return openElement(state, 'em')
    case 'strong_open':
      return openElement(state, 'strong')
    case 's_open':
      return openElement(state, 's')
    case 'link_open':
      return openLink(state, tokens, index, token)
    default:
      return {node: currentNode(state)}
  }
}

function closeFrame(state: State): void {
  if (state.stack.length <= 1) return
  const frame = state.stack.pop()
  if (frame?.after !== undefined) currentNode(state).appendChild(frame.after())
}

function appendCode(state: State, content: string, block: boolean): void {
  const code = createElement(state, 'code')
  appendText(state, code, content)
  if (block) {
    const pre = createElement(state, 'pre')
    pre.appendChild(code)
    currentNode(state).appendChild(pre)
  } else {
    currentNode(state).appendChild(code)
  }
}

function walk(state: State, tokens: readonly Token[]): void {
  for (const [index, token] of tokens.entries()) {
    if (token.nesting === 1) {
      state.stack.push(openFrame(state, tokens, index, token))
      continue
    }
    if (token.nesting === -1) {
      closeFrame(state)
      continue
    }
    switch (token.type) {
      case 'inline':
        walk(state, token.children ?? [])
        break
      case 'softbreak':
        appendText(state, currentNode(state), '\n')
        break
      case 'hardbreak':
        currentNode(state).appendChild(createElement(state, 'br'))
        break
      case 'hr':
        currentNode(state).appendChild(createElement(state, 'hr'))
        break
      case 'code_inline':
        appendCode(state, token.content, false)
        break
      case 'fence':
      case 'code_block':
        appendCode(state, token.content, true)
        break
      case 'image':
        // Never an element. Alt text stands in for the image.
        appendText(state, currentNode(state), token.content === '' ? '[image]' : token.content)
        break
      default:
        // text, and any token type the allowlist does not know: its text is kept.
        appendText(state, currentNode(state), token.content)
    }
  }
}

/** Throws when the output would need more than MAX_OUTPUT_NODES nodes; callers fall back to plain text. */
export function renderOutput(text: string, {doc, origin}: RenderOptions): DocumentFragment {
  const root = doc.createDocumentFragment()
  const state: State = {doc, pageOrigin: normalizeOrigin(origin), stack: [{node: root}], nodes: 0}
  walk(state, markdownIt.parse(text, {}))
  return root
}
