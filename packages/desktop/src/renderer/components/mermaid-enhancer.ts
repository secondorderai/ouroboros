import { getMermaidPaletteEntry, type PaletteEntry } from './mermaid-theme'

export type MermaidDiagramType =
  | 'flowchart'
  | 'sequence'
  | 'state'
  | 'class'
  | 'er'
  | 'gantt'
  | 'timeline'
  | 'journey'
  | 'kanban'
  | 'mindmap'
  | 'chart'
  | 'unknown'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface ClusterBox {
  box: Box
  paletteIndex: number
}

const NODE_SHAPE_SELECTOR = 'rect, polygon, circle, ellipse, path'
const EDGE_SELECTOR = [
  '.edgePath path',
  '.flowchart-link',
  '.messageLine0',
  '.messageLine1',
  '.relationshipLine',
  '.transition',
  '.relation',
  'path[class*="edge"]',
  'path[class*="message"]',
].join(', ')

export function detectMermaidDiagramType(source: string): MermaidDiagramType {
  const trimmed = source.trimStart()
  if (/^(graph|flowchart|architecture|block)(?:\b|-)/i.test(trimmed)) return 'flowchart'
  if (/^sequenceDiagram\b/i.test(trimmed)) return 'sequence'
  if (/^stateDiagram(?:-v2)?\b/i.test(trimmed)) return 'state'
  if (/^classDiagram(?:-v2)?\b/i.test(trimmed)) return 'class'
  if (/^erDiagram\b/i.test(trimmed)) return 'er'
  if (/^gantt\b/i.test(trimmed)) return 'gantt'
  if (/^timeline\b/i.test(trimmed)) return 'timeline'
  if (/^journey\b/i.test(trimmed)) return 'journey'
  if (/^kanban\b/i.test(trimmed)) return 'kanban'
  if (/^(mindmap|treeView|treemap|sankey)(?:\b|-)/i.test(trimmed)) return 'mindmap'
  if (/^(pie|quadrantChart|xychart|radar|gitGraph|venn)(?:\b|-)/i.test(trimmed)) return 'chart'
  return 'unknown'
}

export function hasAuthorMermaidStyling(source: string): boolean {
  return /^\s*(classDef|class\s+\S+|style\s+\S+)/im.test(source)
}

export function enhanceMermaidSvg(
  svg: string,
  source: string,
  theme: 'light' | 'dark',
): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return svg
  }

  try {
    const parser = new DOMParser()
    const document = parser.parseFromString(svg, 'image/svg+xml')
    const root = document.documentElement
    if (!root || root.nodeName !== 'svg' || root.querySelector('parsererror')) {
      return svg
    }

    const type = detectMermaidDiagramType(source)
    root.setAttribute('data-ou-diagram-type', type)
    root.setAttribute('data-ou-enhanced', 'true')

    if (!hasAuthorMermaidStyling(source)) {
      switch (type) {
        case 'flowchart':
          enhanceFlowchart(root, theme)
          break
        case 'sequence':
          enhanceSequence(root, theme)
          break
        case 'state':
          enhanceGroupedDiagram(root, theme, [
            'g.stateGroup',
            'g.state',
            'g.node',
            'g[class*="state"]',
          ])
          break
        case 'class':
          enhanceGroupedDiagram(root, theme, ['g.classGroup', 'g.class', 'g.node'])
          break
        case 'er':
          enhanceGroupedDiagram(root, theme, ['g.entityBox', 'g.entity', 'g.node'])
          break
        case 'gantt':
        case 'timeline':
        case 'journey':
        case 'kanban':
          enhanceLaneDiagram(root, theme)
          break
        case 'mindmap':
          enhanceGroupedDiagram(root, theme, [
            'g.mindmap-node',
            'g.mindmapNode',
            'g.node',
            'g[class*="node"]',
          ])
          break
        case 'chart':
        case 'unknown':
          break
      }
      normalizeDiagramStrokeWeights(root)
    }

    enhanceEdges(root, theme)
    return new XMLSerializer().serializeToString(root)
  } catch {
    return svg
  }
}

function enhanceFlowchart(root: Element, theme: 'light' | 'dark') {
  const clusters = selectAll(root, 'g.cluster')
  const clusterBoxes: ClusterBox[] = []

  clusters.forEach((cluster, index) => {
    const entry = getMermaidPaletteEntry(theme, index)
    const shape = cluster.querySelector('rect, polygon, path')
    if (shape) {
      applyShapePalette(shape, entry, { soft: true, strokeWidth: '1px' })
    }
    applyTextPalette(cluster, entry)
    const box = readBox(shape)
    if (box) {
      clusterBoxes.push({ box, paletteIndex: index })
    }
  })

  const nodes = selectAll(root, 'g.node')
  nodes.forEach((node, index) => {
    const nodeBox = readBox(node.querySelector(NODE_SHAPE_SELECTOR))
    const center = nodeBox
      ? { x: nodeBox.x + nodeBox.width / 2, y: nodeBox.y + nodeBox.height / 2 }
      : null
    const containingCluster =
      center && clusterBoxes.find((cluster) => containsPoint(cluster.box, center.x, center.y))
    const paletteIndex = containingCluster?.paletteIndex ?? index
    applyNodePalette(node, getMermaidPaletteEntry(theme, paletteIndex))
  })
}

function enhanceSequence(root: Element, theme: 'light' | 'dark') {
  const actorParents: HTMLElement[] = [
    ...selectAll(root, 'rect.actor').map((shape) => shape.parentElement),
    ...selectAll(root, '[class*="actor"]').map((shape) => shape.parentElement),
  ].filter((element): element is HTMLElement => element != null)
  const actors = uniqueElements([...selectAll(root, 'g.actor'), ...actorParents])

  actors.forEach((actor, index) => {
    const entry = getMermaidPaletteEntry(theme, index)
    selectAll(actor, 'rect, path, polygon').forEach((shape) =>
      applyShapePalette(shape, entry, { soft: true, strokeWidth: '1px' }),
    )
    applyTextPalette(actor, entry)
  })

  selectAll(root, 'rect[class*="activation"], path[class*="activation"]').forEach((shape, index) => {
    const entry = getMermaidPaletteEntry(theme, index)
    applyShapePalette(shape, entry, { soft: false, strokeWidth: '1px' })
  })

  selectAll(root, 'rect[class*="loop"], rect[class*="note"], path[class*="note"]').forEach(
    (shape, index) => {
      applyShapePalette(shape, getMermaidPaletteEntry(theme, index + 1), {
        soft: true,
        strokeWidth: '1px',
      })
    },
  )
}

function enhanceGroupedDiagram(root: Element, theme: 'light' | 'dark', selectors: string[]) {
  const groups = uniqueElements(selectors.flatMap((selector) => selectAll(root, selector)))
  groups.forEach((group, index) => {
    applyNodePalette(group, getMermaidPaletteEntry(theme, index))
  })
}

function enhanceLaneDiagram(root: Element, theme: 'light' | 'dark') {
  const laneShapes = selectAll(
    root,
    [
      'rect.section',
      'rect[class*="section"]',
      'rect[class*="task"]',
      'rect[class*="journey"]',
      'rect[class*="kanban"]',
      'rect[class*="timeline"]',
      'g.section rect',
      'g.task rect',
    ].join(', '),
  )

  laneShapes.forEach((shape, index) => {
    applyShapePalette(shape, getMermaidPaletteEntry(theme, index), {
      soft: index % 2 === 0,
      strokeWidth: '1px',
    })
  })
}

function enhanceEdges(root: Element, theme: 'light' | 'dark') {
  const edge = getMermaidPaletteEntry(theme, 0)
  selectAll(root, EDGE_SELECTOR).forEach((shape) => {
    mergeStyle(shape, {
      stroke: edge.border,
      'stroke-width': '1.25px',
    })
  })
}

function normalizeDiagramStrokeWeights(root: Element) {
  selectAll(root, 'rect, polygon, circle, ellipse, path').forEach((shape) => {
    const stroke = shape.getAttribute('stroke')
    const style = shape.getAttribute('style') ?? ''
    if (stroke === 'none' || /(?:^|;)\s*stroke\s*:\s*none\b/i.test(style)) {
      return
    }
    mergeStyle(shape, { 'stroke-width': '1px' })
  })
}

function applyNodePalette(group: Element, entry: PaletteEntry) {
  const shape = group.querySelector(NODE_SHAPE_SELECTOR)
  if (shape) {
    applyShapePalette(shape, entry, { soft: false, strokeWidth: '1px' })
  }
  applyTextPalette(group, entry)
}

function applyShapePalette(
  element: Element,
  entry: PaletteEntry,
  options: { soft: boolean; strokeWidth: string },
) {
  mergeStyle(element, {
    fill: entry.fill,
    stroke: entry.border,
    'stroke-width': options.strokeWidth,
    opacity: options.soft ? '0.92' : '1',
  })
  element.setAttribute('data-ou-palette-border', entry.border)
}

function applyTextPalette(scope: Element, entry: PaletteEntry) {
  selectAll(scope, 'text, tspan, foreignObject div, foreignObject span').forEach((text) => {
    mergeStyle(text, { color: entry.label, fill: entry.label })
  })
}

function mergeStyle(element: Element, updates: Record<string, string>) {
  const existing = parseStyle(element.getAttribute('style') ?? '')
  Object.entries(updates).forEach(([key, value]) => {
    existing.set(key, value)
  })
  element.setAttribute(
    'style',
    [...existing.entries()].map(([key, value]) => `${key}: ${value}`).join('; '),
  )
}

function parseStyle(style: string): Map<string, string> {
  const parsed = new Map<string, string>()
  style
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((declaration) => {
      const separator = declaration.indexOf(':')
      if (separator === -1) return
      parsed.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim())
    })
  return parsed
}

function readBox(element: Element | null): Box | null {
  if (!element) return null
  const tag = element.tagName.toLowerCase()
  if (tag === 'rect') {
    const x = readNumber(element, 'x')
    const y = readNumber(element, 'y')
    const width = readNumber(element, 'width')
    const height = readNumber(element, 'height')
    if ([x, y, width, height].every((value) => value != null)) {
      return { x: x!, y: y!, width: width!, height: height! }
    }
  }
  return null
}

function containsPoint(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
}

function readNumber(element: Element, attribute: string): number | null {
  const value = element.getAttribute(attribute)
  if (!value) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function selectAll(root: Element, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector))
  } catch {
    return []
  }
}

function uniqueElements(elements: Element[]): Element[] {
  return [...new Set(elements)]
}
