#!/usr/bin/env node
/**
 * One-shot measurement of the DiceBear `gaze` body shapes.
 *
 * Every shape variant draws its body as a single primitive on a 100×100 canvas.
 * We parse that primitive's real geometry — sampling Bézier and elliptical-arc
 * segments rather than trusting the control points — and print the ink bounding
 * box plus the scale that makes the shape's long side cover `TARGET_FILL` of the
 * avatar container.
 *
 * Run:  node scripts/measure-mascot-shapes.mjs
 * Read: node_modules/@dicebear/styles/dist/gaze.min.json → components.shape.variants
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STYLE_FILE = join(ROOT, 'node_modules', '@dicebear', 'styles', 'dist', 'gaze.min.json')
const TARGET_FILL = 0.98
/** Enough that a sampled curve extremum lands within ~0.01 viewBox units. */
const SAMPLES_PER_CURVE = 128

function bboxOfElement(element) {
  const attributes = element.attributes
  const box = new Box()
  switch (element.name) {
    case 'path':
      bboxOfPath(attributes.d, box)
      return box
    case 'circle': {
      const cx = number(attributes.cx)
      const cy = number(attributes.cy)
      const r = number(attributes.r)
      box.add(cx - r, cy - r)
      box.add(cx + r, cy + r)
      return box
    }
    case 'rect': {
      const x = number(attributes.x, 0)
      const y = number(attributes.y, 0)
      box.add(x, y)
      box.add(x + number(attributes.width), y + number(attributes.height))
      return box
    }
    case 'polygon':
    case 'polyline': {
      const values = attributes.points.trim().split(/[\s,]+/).map(Number)
      for (let index = 0; index + 1 < values.length; index += 2) box.add(values[index], values[index + 1])
      return box
    }
    default:
      throw new Error(`unsupported body element <${element.name}>`)
  }
}

function bboxOfPath(d, box) {
  let current = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  let lastCubicControl = null
  let lastQuadraticControl = null

  for (const { command, args } of parsePath(d)) {
    const relative = command === command.toLowerCase()
    const upper = command.toUpperCase()
    const origin = relative ? current : { x: 0, y: 0 }
    const point = (index) => ({ x: origin.x + args[index], y: origin.y + args[index + 1] })

    switch (upper) {
      case 'M': {
        current = point(0)
        start = current
        box.add(current.x, current.y)
        break
      }
      case 'L': {
        const end = point(0)
        box.add(end.x, end.y)
        current = end
        break
      }
      case 'H': {
        current = { x: origin.x + args[0], y: current.y }
        box.add(current.x, current.y)
        break
      }
      case 'V': {
        current = { x: current.x, y: origin.y + args[0] }
        box.add(current.x, current.y)
        break
      }
      case 'C': {
        const control1 = point(0)
        const control2 = point(2)
        const end = point(4)
        sampleCubic(current, control1, control2, end, box)
        current = end
        break
      }
      case 'S': {
        const control1 = reflect(lastCubicControl, current)
        const control2 = point(0)
        const end = point(2)
        sampleCubic(current, control1, control2, end, box)
        current = end
        break
      }
      case 'Q': {
        const control = point(0)
        const end = point(2)
        sampleQuadratic(current, control, end, box)
        current = end
        break
      }
      case 'T': {
        const control = reflect(lastQuadraticControl, current)
        const end = point(0)
        sampleQuadratic(current, control, end, box)
        current = end
        break
      }
      case 'A': {
        const end = point(5)
        sampleArc(current, {
          rx: Math.abs(args[0]),
          ry: Math.abs(args[1]),
          rotation: args[2],
          largeArc: args[3] !== 0,
          sweep: args[4] !== 0,
          end,
        }, box)
        current = end
        break
      }
      case 'Z': {
        current = start
        break
      }
      default:
        throw new Error(`unsupported path command ${command}`)
    }

    if (upper !== 'C' && upper !== 'S') lastCubicControl = null
    if (upper !== 'Q' && upper !== 'T') lastQuadraticControl = null
    if (upper === 'C') lastCubicControl = point(2)
    if (upper === 'S') lastCubicControl = point(0)
    if (upper === 'Q') lastQuadraticControl = point(0)
    if (upper === 'T') lastQuadraticControl = reflect(lastQuadraticControl, current)
  }
}

/** Tokenize one `d` attribute and group arguments per drawing command. */
function parsePath(d) {
  const commands = []
  const token = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g
  const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
  let command = null
  let args = []
  for (const match of d.matchAll(token)) {
    if (match[1] !== undefined) {
      if (args.length !== 0) throw new Error(`unfinished ${command} before ${match[1]} in ${d}`)
      command = match[1]
      if (arity[command.toUpperCase()] === 0) commands.push({ command, args: [] })
      continue
    }
    if (command === null) throw new Error(`number before first command in ${d}`)
    args.push(Number(match[2]))
    const count = arity[command.toUpperCase()]
    if (args.length !== count) continue
    commands.push({ command, args })
    // Repeated coordinates after a move are implicit lineto commands.
    if (command === 'M') command = 'L'
    if (command === 'm') command = 'l'
    args = []
  }
  if (args.length !== 0) throw new Error(`incomplete command ${command} in ${d}`)
  return commands
}

function sampleCubic(start, control1, control2, end, box) {
  for (let step = 0; step <= SAMPLES_PER_CURVE; step += 1) {
    const t = step / SAMPLES_PER_CURVE
    const u = 1 - t
    box.add(
      u * u * u * start.x + 3 * u * u * t * control1.x + 3 * u * t * t * control2.x + t * t * t * end.x,
      u * u * u * start.y + 3 * u * u * t * control1.y + 3 * u * t * t * control2.y + t * t * t * end.y,
    )
  }
}

function sampleQuadratic(start, control, end, box) {
  for (let step = 0; step <= SAMPLES_PER_CURVE; step += 1) {
    const t = step / SAMPLES_PER_CURVE
    const u = 1 - t
    box.add(
      u * u * start.x + 2 * u * t * control.x + t * t * end.x,
      u * u * start.y + 2 * u * t * control.y + t * t * end.y,
    )
  }
}

/** SVG endpoint → center parameterization (SVG 1.1 F.6.5), then sample θ. */
function sampleArc(start, { rx, ry, rotation, largeArc, sweep, end }, box) {
  if (rx === 0 || ry === 0) {
    box.add(end.x, end.y)
    return
  }
  const phi = (rotation * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (start.x - end.x) / 2
  const dy = (start.y - end.y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy

  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    const grow = Math.sqrt(lambda)
    rx *= grow
    ry *= grow
  }

  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const numerator = rx * rx * ry * ry - denominator
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator))
  const cx1 = (factor * rx * y1) / ry
  const cy1 = (-factor * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (start.x + end.x) / 2
  const cy = sin * cx1 + cos * cy1 + (start.y + end.y) / 2

  const angle = (ux, uy, vx, vy) => {
    const signed = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return signed
  }
  const ux = (x1 - cx1) / rx
  const uy = (y1 - cy1) / ry
  const vx = (-x1 - cx1) / rx
  const vy = (-y1 - cy1) / ry
  const startAngle = angle(1, 0, ux, uy)
  let sweepAngle = angle(ux, uy, vx, vy)
  if (sweepAngle < 0 && !sweep) sweepAngle += 2 * Math.PI
  if (sweepAngle > 0 && sweep) sweepAngle -= 2 * Math.PI

  for (let step = 0; step <= SAMPLES_PER_CURVE; step += 1) {
    const theta = startAngle + (sweepAngle * step) / SAMPLES_PER_CURVE
    box.add(
      cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
      cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
    )
  }
}

function reflect(control, around) {
  return control === null ? around : { x: 2 * around.x - control.x, y: 2 * around.y - control.y }
}

function number(value, fallback) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error('missing numeric attribute')
  }
  return Number(value)
}

function round(value) {
  return Number(value.toFixed(3))
}

class Box {
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  add(x, y) {
    this.minX = Math.min(this.minX, x)
    this.minY = Math.min(this.minY, y)
    this.maxX = Math.max(this.maxX, x)
    this.maxY = Math.max(this.maxY, y)
  }
}

function printTable(table) {
  const header = ['shape', 'x', 'y', 'width', 'height', 'fillRatio', 'scale']
  const body = table.map(row => [row.shape, row.x, row.y, row.width, row.height, row.fillRatio, row.scale])
  const widths = header.map((title, index) => Math.max(
    title.length,
    ...body.map(row => String(row[index]).length),
  ))
  const line = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd()
  console.log(line(header))
  for (const row of body) console.log(line(row))
  console.log(`\ntargetFill=${TARGET_FILL}, samplesPerCurve=${SAMPLES_PER_CURVE}, canvas=100x100`)
}

selfCheck()

const style = JSON.parse(await readFile(STYLE_FILE, 'utf8'))
const variants = style.components.shape.variants

const rows = []
for (const [shape, variant] of Object.entries(variants)) {
  const body = variant.elements.find(element => element.type === 'element' && element.name !== 'g')
  if (body === undefined) throw new Error(`${shape}: no body element`)
  if (body.attributes.transform !== undefined) throw new Error(`${shape}: unexpected body transform`)
  const box = bboxOfElement(body)
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  const fillRatio = Math.max(width, height) / 100
  rows.push({
    shape,
    x: round(box.minX),
    y: round(box.minY),
    width: round(width),
    height: round(height),
    fillRatio: round(fillRatio),
    scale: round(TARGET_FILL / fillRatio),
  })
}

printTable(rows)

/**
 * Cheap guard for the hand-written geometry code: bounds with a closed-form
 * answer, exercised before the real measurement so a broken sampler cannot
 * print a plausible table. Silent on success, throws on regression.
 */
function selfCheck() {
  const expect = (label, box, expected) => {
    const actual = [box.minX, box.minY, box.maxX, box.maxY].map(value => round(value))
    if (actual.some((value, index) => Math.abs(value - expected[index]) > 0.001)) {
      throw new Error(`self-check ${label}: expected ${expected}, got ${actual}`)
    }
  }
  // Two half-arcs trace the full circle r=36 around (50,50).
  const arc = new Box()
  bboxOfPath('M14 50A36 36 0 0 1 86 50A36 36 0 0 1 14 50Z', arc)
  expect('arc circle', arc, [14, 14, 86, 86])
  // Symmetric quadratic: y peaks at half the control-point height.
  const quadratic = new Box()
  bboxOfPath('M0 0Q50 100 100 0', quadratic)
  expect('quadratic', quadratic, [0, 0, 100, 50])
  // Symmetric cubic: y peaks at 0.75 of the control-point height.
  const cubic = new Box()
  bboxOfPath('M0 0C0 100 100 100 100 0', cubic)
  expect('cubic', cubic, [0, 0, 100, 75])
}
