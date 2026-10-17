/**
 * Behavioral tests for the Markdown output renderer: every output is checked against an explicit
 * element/attribute/href allowlist, over a malicious-input corpus and over ordinary Markdown.
 */

import type {Token} from 'markdown-it'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {MAX_OUTPUT_NODES, markdownIt, renderOutput} from './markdown-output.ts'
import rendererSource from './markdown-output.ts?raw'

const ORIGIN = 'https://dash.example'

const TABLE_CLASS = 'run-output-table'
const HOST_CLASS = 'run-output-link-host'

const ALLOWED_TAGS = new Set([
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'pre',
  'code',
  'em',
  'strong',
  's',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'div',
  'span',
  'a',
])

const ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ['href', 'target', 'rel'],
  ol: ['start'],
  div: ['class'],
  span: ['class'],
}

function render(text: string, origin = ORIGIN): DocumentFragment {
  return renderOutput(text, {doc: document, origin})
}

/** Every descendant, depth-first. Iterative so deep nesting cannot overflow the test's stack. */
function descendants(root: Node): Node[] {
  const out: Node[] = []
  const pending: Node[] = [...root.childNodes].reverse()
  while (pending.length > 0) {
    const node = pending.pop() as Node
    out.push(node)
    for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i] as Node)
  }
  return out
}

function elementsOf(root: Node): Element[] {
  return descendants(root).filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
}

function anchorsOf(root: Node): HTMLAnchorElement[] {
  return elementsOf(root).filter((el): el is HTMLAnchorElement => el.tagName === 'A')
}

function tagsOf(root: Node): string[] {
  return elementsOf(root).map(el => el.tagName.toLowerCase())
}

/** P2: nothing outside the explicit allowlist, over any output. */
function expectAllowlisted(root: Node): void {
  for (const node of descendants(root)) {
    expect([Node.ELEMENT_NODE, Node.TEXT_NODE]).toContain(node.nodeType)
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    expect(ALLOWED_TAGS.has(tag), `tag <${tag}> is not allowlisted`).toBe(true)
    const allowed = ALLOWED_ATTRIBUTES[tag] ?? []
    for (const name of el.getAttributeNames()) {
      expect(allowed.includes(name), `attribute ${name} on <${tag}> is not allowlisted`).toBe(true)
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? ''
      expect(['http:', 'https:']).toContain(new URL(href).protocol)
      expect(el.getAttribute('target')).toBe('_blank')
      expect(el.getAttribute('rel')).toBe('noopener noreferrer')
    }
    if (tag === 'div') expect(el.getAttribute('class')).toBe(TABLE_CLASS)
    if (tag === 'span') expect(el.getAttribute('class')).toBe(HOST_CLASS)
    if (tag === 'ol' && el.hasAttribute('start')) expect(el.getAttribute('start')).toMatch(/^[1-9]\d*$/)
  }
}

/** The absence checks that sit beside the allowlist. */
function expectNoActiveContent(root: Node): void {
  const tags = tagsOf(root)
  for (const forbidden of ['img', 'script', 'iframe', 'style', 'svg', 'object', 'embed', 'link', 'form']) {
    expect(tags).not.toContain(forbidden)
  }
  for (const el of elementsOf(root)) {
    for (const name of el.getAttributeNames()) {
      expect(name.startsWith('on')).toBe(false)
      expect(name).not.toBe('style')
      expect(name).not.toBe('src')
    }
  }
}

function innerText(root: Node): string {
  return root.textContent ?? ''
}

describe('P5 malicious corpus', () => {
  // `literal`, when present, must appear verbatim in the rendered text.
  const corpus: {name: string; input: string; literal?: string}[] = [
    {name: 'script block', input: '<script>alert(1)</script>', literal: '<script>alert(1)</script>'},
    {name: 'script inline', input: 'hi <script>alert(1)</script> there', literal: '<script>alert(1)</script>'},
    {name: 'img onerror', input: '<img src=x onerror=alert(1)>', literal: '<img src=x onerror=alert(1)>'},
    {name: 'img onerror inline', input: 'a <img src="x" onerror="alert(1)"> b', literal: '<img src="x" onerror="alert(1)">'},
    {name: 'svg onload', input: '<svg onload=alert(1)></svg>', literal: '<svg onload=alert(1)></svg>'},
    {name: 'svg block with children', input: '<svg>\n<script>alert(1)</script>\n</svg>', literal: '<svg>'},
    {name: 'iframe', input: '<iframe src="https://evil.example"></iframe>', literal: '<iframe src="https://evil.example"></iframe>'},
    {name: 'style element', input: '<style>*{background:url(https://evil.example/x)}</style>', literal: '<style>'},
    {name: 'raw block html with handler', input: '<div onclick="x()">hi</div>\n\ntext', literal: '<div onclick="x()">'},
    {name: 'raw inline html with handler', input: 'a <b onmouseover=x>bold</b> c', literal: '<b onmouseover=x>'},
    {name: 'raw anchor with javascript href', input: '<a href="javascript:alert(1)">x</a>', literal: '<a href="javascript:alert(1)">'},
    {name: 'form', input: '<form action="https://evil.example"><input name=a></form>', literal: '<form action="https://evil.example">'},
    {name: 'details ontoggle', input: '<details open ontoggle=alert(1)>x</details>', literal: '<details open ontoggle=alert(1)>'},
    {name: 'html comment', input: '<!-- hidden --> shown', literal: '<!-- hidden -->'},
    {name: 'doubled angle bracket', input: '<<script>script>alert(1)<</script>/script>', literal: 'alert(1)'},
    {name: 'named entities', input: '&lt;script&gt;alert(1)&lt;/script&gt;', literal: '<script>alert(1)</script>'},
    {name: 'numeric entities', input: '&#60;img src=x onerror=alert(1)&#62;', literal: '<img src=x onerror=alert(1)>'},
    {name: 'broken nesting', input: '<b><i>x</b></i>', literal: '<b><i>x</b></i>'},
    {name: 'html inside emphasis', input: '**<img src=x onerror=a>**', literal: '<img src=x onerror=a>'},
    {name: 'html inside link label', input: '[<img src=x onerror=a>](https://e.example/)', literal: '<img src=x onerror=a>'},
    {name: 'attribute breakout in image alt', input: '![x" onerror="a](https://e.example/i.png)', literal: 'x" onerror="a'},
    {name: 'attribute breakout in link title', input: '[x](https://e.example/ "\\" onclick=\\"a")'},
    {name: 'html in code span', input: '`<script>alert(1)</script>`', literal: '<script>alert(1)</script>'},
    {name: 'html in fence', input: '```html\n<script>alert(1)</script>\n```', literal: '<script>alert(1)</script>'},
    {name: 'html in indented code', input: '    <img src=x onerror=a>', literal: '<img src=x onerror=a>'},
    {name: 'html in table cell', input: '| a | b |\n|---|---|\n| <img src=x onerror=a> | <script>1</script> |', literal: '<script>1</script>'},
    {name: 'html in heading', input: '# <script>alert(1)</script>', literal: '<script>alert(1)</script>'},
    {name: 'html in list item', input: '- <iframe src="https://evil.example"></iframe>', literal: '<iframe src="https://evil.example">'},
    {name: 'javascript link', input: '[x](javascript:alert(1))', literal: 'javascript:alert(1)'},
    {name: 'mixed-case javascript link', input: '[x](JaVaScRiPt:alert(1))', literal: 'JaVaScRiPt:alert(1)'},
    {name: 'entity-encoded javascript link', input: '[x](&#x6A;avascript:alert(1))'},
    {name: 'data html link', input: '[x](data:text/html,<script>alert(1)</script>)'},
    {name: 'data svg image', input: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)'},
    {name: 'javascript autolink', input: '<javascript:alert(1)>'},
    {name: 'javascript reference link', input: '[x][r]\n\n[r]: javascript:alert(1)'},
    {name: 'null and control bytes', input: 'a\u0000<script>\u0007alert(1)</script>'},
  ]

  it.each(corpus)('$name renders only allowlisted nodes', ({input, literal}) => {
    const out = render(input)
    expectAllowlisted(out)
    expectNoActiveContent(out)
    if (literal !== undefined) expect(innerText(out)).toContain(literal)
    for (const a of anchorsOf(out)) expect(a.getAttribute('href')).not.toMatch(/javascript|data:/i)
  })

  it('keeps raw HTML as text only because html is off', () => {
    // If html were flipped on, the script/img corpus entries above would parse into elements and fail.
    expect(markdownIt.options.html).toBe(false)
    const out = render('<script>alert(1)</script>')
    expect(tagsOf(out)).toEqual(['p'])
  })
})

describe('allowlisted constructs', () => {
  it('clamps headings to h4-h6', () => {
    const out = render('# one\n\n## two\n\n### three\n\n#### four\n\n##### five\n\n###### six\n\nsetext\n======')
    expect(tagsOf(out).filter(tag => tag.startsWith('h'))).toEqual(['h4', 'h4', 'h4', 'h4', 'h5', 'h6', 'h4'])
    expectAllowlisted(out)
  })

  it('renders a tight list without paragraph wrappers', () => {
    const out = render('- a\n- b')
    expect(tagsOf(out)).toEqual(['ul', 'li', 'li'])
    expect(innerText(out)).toBe('ab')
  })

  it('renders a loose list with paragraphs', () => {
    const out = render('- a\n\n- b')
    expect(tagsOf(out)).toEqual(['ul', 'li', 'p', 'li', 'p'])
  })

  it('renders nested lists', () => {
    const out = render('- a\n  - b\n  - c\n- d')
    expect(tagsOf(out)).toEqual(['ul', 'li', 'ul', 'li', 'li', 'li'])
    const nested = out.querySelector('li > ul')
    expect(nested?.children).toHaveLength(2)
  })

  it('keeps an ordered list start and omits a default or zero start', () => {
    expect(render('3. a\n4. b').querySelector('ol')?.getAttribute('start')).toBe('3')
    expect(render('1. a\n2. b').querySelector('ol')?.hasAttribute('start')).toBe(false)
    expect(render('0. a\n1. b').querySelector('ol')?.hasAttribute('start')).toBe(false)
  })

  it('keeps a nine-digit ordered list start', () => {
    expect(render('123456789. a\n123456790. b').querySelector('ol')?.getAttribute('start')).toBe('123456789')
  })

  it('does not turn a ten-digit start into a list with that start', () => {
    const out = render('1234567890. a\n1234567891. b')
    expect(out.querySelector('ol')).toBeNull()
    expect(innerText(out)).toContain('1234567890. a')
  })

  it('renders blockquotes, including nested ones', () => {
    const out = render('> a\n> b\n>\n> > nested')
    expect(tagsOf(out)).toEqual(['blockquote', 'p', 'blockquote', 'p'])
  })

  it('renders a table inside its wrapper and drops alignment', () => {
    const out = render('| a | b |\n|:--|--:|\n| 1 | 2 |')
    expect(tagsOf(out)).toEqual(['div', 'table', 'thead', 'tr', 'th', 'th', 'tbody', 'tr', 'td', 'td'])
    const wrapper = out.firstElementChild as Element
    expect(wrapper.getAttribute('class')).toBe(TABLE_CLASS)
    expect(wrapper.firstElementChild?.tagName).toBe('TABLE')
    for (const cell of out.querySelectorAll('th, td')) expect(cell.getAttributeNames()).toEqual([])
    expectAllowlisted(out)
  })

  it('renders fenced and indented code, dropping the info string', () => {
    const fenced = render('```js title="x"\nconst a = 1\n```')
    expect(tagsOf(fenced)).toEqual(['pre', 'code'])
    expect(fenced.querySelector('code')?.getAttributeNames()).toEqual([])
    expect(fenced.querySelector('code')?.textContent).toBe('const a = 1\n')
    const indented = render('    plain code')
    expect(tagsOf(indented)).toEqual(['pre', 'code'])
    expect(indented.querySelector('code')?.textContent).toContain('plain code')
  })

  it('renders emphasis, strong, strikethrough, inline code, hr and hard breaks', () => {
    const out = render('*a* _b_ **c** ~~d~~ `e`\n\n---\n\nline  \nbreak\\\nagain')
    expect(tagsOf(out)).toEqual(['p', 'em', 'em', 'strong', 's', 'code', 'hr', 'p', 'br', 'br'])
  })

  it('turns a soft break into a newline text node', () => {
    const out = render('one\ntwo')
    expect(tagsOf(out)).toEqual(['p'])
    expect(innerText(out)).toBe('one\ntwo')
  })

  it('builds nodes with the document it is given', () => {
    const other = document.implementation.createHTMLDocument('other')
    const out = renderOutput('**bold** and `code`', {doc: other, origin: ORIGIN})
    for (const node of descendants(out)) expect(node.ownerDocument).toBe(other)
    expect(out.ownerDocument).toBe(other)
  })
})

describe('links', () => {
  const rejected: {name: string; markdown: string; label: string; destination: string}[] = [
    {name: 'javascript:', markdown: '[click](javascript:alert(1))', label: 'click', destination: 'javascript:alert(1)'},
    {name: 'data:', markdown: '[click](data:text/html,hi)', label: 'click', destination: 'data:text/html,hi'},
    {name: 'vbscript:', markdown: '[click](vbscript:msgbox(1))', label: 'click', destination: 'vbscript:msgbox(1)'},
    {name: 'file:', markdown: '[click](file:///etc/passwd)', label: 'click', destination: 'file:///etc/passwd'},
    {name: 'java\\nscript:', markdown: '[click](java\nscript:alert(1))', label: 'click', destination: 'script:alert(1)'},
    {name: 'mailto:', markdown: '[click](mailto:a@b.example)', label: 'click', destination: 'mailto:a@b.example'},
    {name: 'relative path', markdown: '[click](/operator/runs/x)', label: 'click', destination: '/operator/runs/x'},
    {name: 'relative dot path', markdown: '[click](../up/page.html)', label: 'click', destination: '../up/page.html'},
    {name: 'fragment', markdown: '[click](#frag)', label: 'click', destination: '#frag'},
    {name: 'protocol-relative', markdown: '[click](//evil.example/p)', label: 'click', destination: '//evil.example/p'},
    {name: 'ftp:', markdown: '[click](ftp://files.example/f)', label: 'click', destination: 'ftp://files.example/f'},
    {name: 'userinfo with password', markdown: '[click](https://user:pw@host.example/)', label: 'click', destination: 'user:pw@host.example'},
    {name: 'userinfo without password', markdown: '[click](https://user@host.example/)', label: 'click', destination: 'user@host.example'},
    {
      name: 'page origin',
      markdown: '[click](https://dash.example/operator/runs/x/cancel)',
      label: 'click',
      destination: 'https://dash.example/operator/runs/x/cancel',
    },
    {name: 'page origin, other case', markdown: '[click](HTTPS://DASH.EXAMPLE/operator)', label: 'click', destination: 'operator'},
    {name: 'page origin, default port', markdown: '[click](https://dash.example:443/x)', label: 'click', destination: ':443/x'},
    {name: '5,000 characters', markdown: `[click](https://e.example/${'a'.repeat(5000)})`, label: 'click', destination: 'a'.repeat(5000)},
  ]

  it.each(rejected)('rejects $name and shows label plus destination as text', ({markdown, label, destination}) => {
    const out = render(markdown)
    expect(anchorsOf(out)).toHaveLength(0)
    expectAllowlisted(out)
    expect(innerText(out)).toContain(label)
    expect(innerText(out)).toContain(destination)
  })

  it('accepts exactly 2,048 characters and rejects 2,049', () => {
    const prefix = 'https://e.example/'
    const ok = render(`[go](${prefix}${'a'.repeat(2048 - prefix.length)})`)
    expect(anchorsOf(ok)).toHaveLength(1)
    const tooLong = render(`[go](${prefix}${'a'.repeat(2049 - prefix.length)})`)
    expect(anchorsOf(tooLong)).toHaveLength(0)
  })

  it('accepts and normalizes uppercase schemes and hosts', () => {
    const [a] = anchorsOf(render('[go](HTTP://Example.COM/Path)'))
    expect(a?.getAttribute('href')).toBe('http://example.com/Path')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('normalizes a non-ASCII host to punycode', () => {
    const [a] = anchorsOf(render('[go](https://bücher.example/)'))
    expect(a?.getAttribute('href')).toBe('https://xn--bcher-kva.example/')
  })

  it('accepts a different origin that merely shares a prefix with the page origin', () => {
    expect(anchorsOf(render('[go](https://dash.example.evil.example/)'))).toHaveLength(1)
    expect(anchorsOf(render('[go](http://dash.example/)'))).toHaveLength(1)
  })

  it('shows a rejected link whose label is its own destination once, without repeating it in parentheses', () => {
    const url = 'https://dash.example/operator'
    const out = render(`[${url}](${url})`)
    expect(anchorsOf(out)).toHaveLength(0)
    expect(innerText(out)).toBe(url)
  })

  it('fails closed on an unparseable page origin by comparing the raw string', () => {
    expect(anchorsOf(render('[go](https://e.example/)', 'not a url'))).toHaveLength(1)
    expect(anchorsOf(render('[go](https://e.example/)', 'https://e.example'))).toHaveLength(0)
  })

  it('keeps links inside code spans and fences inert', () => {
    const span = render('`[x](https://e.example/)` and `https://e.example/`')
    const fence = render('```\n[x](https://e.example/)\nhttps://e.example/\n```')
    expect(anchorsOf(span)).toHaveLength(0)
    expect(anchorsOf(fence)).toHaveLength(0)
  })

  it('does not copy a token title', () => {
    const [a] = anchorsOf(render('[x](https://e.example/ "tooltip")'))
    expect(a?.hasAttribute('title')).toBe(false)
    expect(a?.getAttributeNames().toSorted()).toEqual(['href', 'rel', 'target'])
  })

  it('resolves reference-style links', () => {
    const [a] = anchorsOf(render('[docs][r]\n\n[r]: https://e.example/ref'))
    expect(a?.getAttribute('href')).toBe('https://e.example/ref')
    expect(a?.textContent).toBe('docs')
  })

  it('linkifies a bare https URL without its trailing punctuation', () => {
    const out = render('see https://example.com/a/b. Next')
    const [a] = anchorsOf(out)
    expect(a?.getAttribute('href')).toBe('https://example.com/a/b')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(innerText(out)).toBe('see https://example.com/a/b. Next')
  })

  it('does not linkify bare hostnames or file names', () => {
    const out = render('open example.com, README.md and www.example.org or a@b.example')
    expect(anchorsOf(out)).toHaveLength(0)
    expect(innerText(out)).toBe('open example.com, README.md and www.example.org or a@b.example')
  })

  it('shows a bare URL that fails the policy once, as text', () => {
    expect(innerText(render('get ftp://files.example/x now'))).toBe('get ftp://files.example/x now')
    expect(innerText(render('see //cdn.example.com/x now'))).toBe('see //cdn.example.com/x now')
    expect(anchorsOf(render('get ftp://files.example/x now'))).toHaveLength(0)
    expect(anchorsOf(render('see https://dash.example/operator now'))).toHaveLength(0)
    expect(innerText(render('see https://dash.example/operator now'))).toBe('see https://dash.example/operator now')
  })
})

describe('link destination host', () => {
  function hostSpans(root: Node): Element[] {
    return elementsOf(root).filter(el => el.tagName === 'SPAN')
  }

  it('shows the destination host right after an anchor whose label is not its URL', () => {
    const out = render('[docs.example.com](https://evil.example/x)')
    const [a] = anchorsOf(out)
    const span = a?.nextSibling as Element
    expect(span.tagName).toBe('SPAN')
    expect(span.getAttribute('class')).toBe(HOST_CLASS)
    expect(span.textContent).toBe(' (evil.example)')
    expectAllowlisted(out)
  })

  it('shows nothing extra for an autolink, a bare URL, or a label that is the URL', () => {
    expect(hostSpans(render('<https://example.com/a>'))).toHaveLength(0)
    expect(hostSpans(render('see https://example.com/a'))).toHaveLength(0)
    expect(hostSpans(render('[https://example.com/a](https://example.com/a)'))).toHaveLength(0)
    expect(anchorsOf(render('<https://example.com/a>'))).toHaveLength(1)
  })

  describe('a non-ASCII host on a link that shows its own URL', () => {
    const CYRILLIC = 'https://раypal.com'
    const CYRILLIC_HOST = new URL(CYRILLIC).hostname
    const hostOf = (out: Node) => hostSpans(out)[0]

    it('has a punycode form to show', () => {
      expect(CYRILLIC_HOST).toMatch(/^xn--/)
    })

    it.each([
      ['a bare URL', `see ${CYRILLIC} now`],
      ['an autolink', `<${CYRILLIC}>`],
      ['an explicit link whose label is its URL', `[${CYRILLIC}](${CYRILLIC})`],
    ])('shows the punycode host after the anchor for %s', (_name, input) => {
      const out = render(input)
      const [a] = anchorsOf(out)
      const span = a?.nextSibling as Element
      expect(span.tagName).toBe('SPAN')
      expect(span.getAttribute('class')).toBe(HOST_CLASS)
      expect(span.textContent).toBe(` (${CYRILLIC_HOST})`)
      expect(a?.getAttribute('href')).toContain(CYRILLIC_HOST)
      expect(hostSpans(out)).toHaveLength(1)
      expectAllowlisted(out)
    })

    it('shows the punycode host of an IDN such as münchen.example', () => {
      for (const input of ['https://münchen.example/a', '<https://münchen.example/a>', '[https://münchen.example/a](https://münchen.example/a)']) {
        expect(hostOf(render(input))?.textContent).toBe(' (xn--mnchen-3ya.example)')
      }
    })

    it('shows the punycode host when the typed URL is punycode but the text shown is decoded', () => {
      const out = render('<https://xn--mnchen-3ya.example/>')
      expect(anchorsOf(out)[0]?.textContent).toBe('https://münchen.example/')
      expect(hostOf(out)?.textContent).toBe(' (xn--mnchen-3ya.example)')
    })

    it('shows the host once when the label is not the URL', () => {
      expect(hostSpans(render('[docs](https://münchen.example/)'))).toHaveLength(1)
    })

    it('shows nothing for an ASCII bare URL, autolink or labelled URL', () => {
      expect(hostSpans(render('see https://example.com/münchen now'))).toHaveLength(0)
      expect(hostSpans(render('<https://example.com/münchen>'))).toHaveLength(0)
      expect(hostSpans(render('[https://example.com/a](https://example.com/a)'))).toHaveLength(0)
    })
  })

  it('omits userinfo and port from the shown host', () => {
    const span = hostSpans(render('[x](https://e.example:8443/p)'))[0]
    expect(span?.textContent).toBe(' (e.example)')
  })

  it('shows a punycode host in punycode form', () => {
    const span = hostSpans(render('[go](https://bücher.example/)'))[0]
    expect(span?.textContent).toBe(' (xn--bcher-kva.example)')
  })

  it('shows no host for a rejected link', () => {
    expect(hostSpans(render('[x](ftp://files.example/f)'))).toHaveLength(0)
  })
})

describe('images', () => {
  it('renders alt text and never an image', () => {
    const out = render('![a cat](https://e.example/c.png)')
    expect(innerText(out)).toBe('a cat')
    expect(tagsOf(out)).toEqual(['p'])
  })

  it('renders [image] for an empty alt', () => {
    expect(innerText(render('![](https://e.example/c.png)'))).toBe('[image]')
  })

  it('uses the alt text as the label of an enclosing link', () => {
    const out = render('[![logo](https://e.example/i.png)](https://e.example/home)')
    const [a] = anchorsOf(out)
    expect(a?.getAttribute('href')).toBe('https://e.example/home')
    expect(a?.textContent).toBe('logo')
    expect(tagsOf(out)).not.toContain('img')
  })

  it('does not turn a javascript: image source into an image or link', () => {
    const out = render('![x](javascript:alert(1))')
    expect(tagsOf(out)).toEqual(['p'])
    expect(innerText(out)).toContain('javascript:alert(1)')
  })
})

describe('edge cases', () => {
  it('returns an empty fragment for empty or blank input', () => {
    expect(render('').childNodes).toHaveLength(0)
    expect(render('  \n\n ').childNodes).toHaveLength(0)
  })

  it('runs an unclosed fence to the end of input', () => {
    const out = render('```\ncode\nmore text')
    expect(tagsOf(out)).toEqual(['pre', 'code'])
    expect(out.querySelector('code')?.textContent).toContain('code\nmore text')
  })

  it('keeps an unmatched asterisk literal', () => {
    const out = render('a * b and *c')
    expect(tagsOf(out)).toEqual(['p'])
    expect(innerText(out)).toBe('a * b and *c')
  })

  it('keeps a half table as a paragraph', () => {
    const out = render('| a | b |')
    expect(tagsOf(out)).toEqual(['p'])
    expect(innerText(out)).toBe('| a | b |')
  })

  it('keeps the text of an unknown token instead of dropping it', () => {
    const tokens = [
      {type: 'paragraph_open', tag: 'p', nesting: 1, hidden: false, attrs: null, content: '', children: null},
      {
        type: 'inline',
        tag: '',
        nesting: 0,
        hidden: false,
        attrs: null,
        content: 'x',
        children: [
          {type: 'text', tag: '', nesting: 0, hidden: false, attrs: null, content: 'a ', children: null},
          {type: 'mystery_inline', tag: 'blink', nesting: 0, hidden: false, attrs: null, content: '<blink>kept</blink>', children: null},
        ],
      },
      {type: 'paragraph_close', tag: 'p', nesting: -1, hidden: false, attrs: null, content: '', children: null},
      {type: 'mystery_block', tag: 'marquee', nesting: 0, hidden: false, attrs: null, content: '<marquee>block</marquee>', children: null},
      {type: 'mystery_open', tag: 'section', nesting: 1, hidden: false, attrs: null, content: '', children: null},
      {type: 'text', tag: '', nesting: 0, hidden: false, attrs: null, content: 'inside', children: null},
      {type: 'mystery_close', tag: 'section', nesting: -1, hidden: false, attrs: null, content: '', children: null},
    ] as unknown as Token[]
    const spy = vi.spyOn(markdownIt, 'parse').mockReturnValueOnce(tokens)
    const out = render('ignored')
    spy.mockRestore()
    expect(innerText(out)).toContain('<blink>kept</blink>')
    expect(innerText(out)).toContain('<marquee>block</marquee>')
    expect(innerText(out)).toContain('inside')
    expectAllowlisted(out)
  })
})

describe('node cap', () => {
  afterEach(() => vi.restoreAllMocks())

  it('throws once more than the cap would be created', () => {
    const paragraphs = Array.from({length: MAX_OUTPUT_NODES}, () => 'a').join('\n\n')
    expect(() => render(paragraphs)).toThrow(/node/i)
  })

  // One paragraph of plain text creates two nodes: the <p> and its text node.
  const NODES_PER_PARAGRAPH = 2
  const paragraphsFor = (nodes: number) => Array.from({length: nodes / NODES_PER_PARAGRAPH}, () => 'a').join('\n\n')

  it('creates two nodes per plain paragraph', () => {
    expect(descendants(render('a'))).toHaveLength(NODES_PER_PARAGRAPH)
  })

  it('renders exactly the cap without throwing', () => {
    const out = render(paragraphsFor(MAX_OUTPUT_NODES))
    expect(descendants(out)).toHaveLength(MAX_OUTPUT_NODES)
  })

  it('throws at one node over the cap', () => {
    // A thematic break adds a single <hr>.
    expect(() => render(`${paragraphsFor(MAX_OUTPUT_NODES)}\n\n---`)).toThrow(/node/i)
  })

  const MAX_INPUT = 256_000
  const pathological: {name: string; input: string}[] = [
    {
      name: '256k table',
      input: `| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(Math.floor(MAX_INPUT / 10))}`,
    },
    {name: 'deeply nested blockquotes', input: `${'> '.repeat(MAX_INPUT / 2)}x`},
    {name: 'deeply nested lists', input: `${'- '.repeat(MAX_INPUT / 2)}x`},
    {name: 'reference links', input: `${'[r] '.repeat(50_000)}\n\n[r]: https://e.example/`},
    {name: 'one 256k line', input: 'a'.repeat(MAX_INPUT)},
    {name: 'repeated emphasis', input: '*a* '.repeat(MAX_INPUT / 4)},
  ]

  it.each(pathological)('$name stays within the cap or throws', ({input}) => {
    let count: number
    try {
      count = descendants(render(input)).length
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/node/i)
      return
    }
    expect(count).toBeLessThanOrEqual(MAX_OUTPUT_NODES)
  })

  it.each(['256k table', 'reference links', 'repeated emphasis'])('%s is rejected by the cap', name => {
    const fixture = pathological.find(entry => entry.name === name)
    expect(() => render(fixture?.input ?? '')).toThrow(/node/i)
  })
})

describe('config pin', () => {
  it('keeps html and typographer off and linkify on', () => {
    expect(markdownIt.options.html).toBe(false)
    expect(markdownIt.options.typographer).toBe(false)
    expect(markdownIt.options.linkify).toBe(true)
  })

  it('never reaches the string renderer or any HTML sink', () => {
    const code = rendererSource.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\.render\(/)
    expect(code).not.toMatch(/\.renderInline\(/)
    expect(code).not.toMatch(/renderer\.rules/)
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser|setHTMLUnsafe/)
  })
})
