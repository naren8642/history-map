/**
 * The ember field as a MapLibre custom WebGL layer.
 *
 * Why not circle layers: MapLibre bakes data-driven paint expressions into
 * per-tile vertex buffers, so animating time through setPaintProperty means
 * re-evaluating the whole corpus in a worker on every change — a queue that
 * can never drain at playback rates. Here the corpus is uploaded once and
 * time is a uniform: advancing the clock costs one triggerRepaint.
 *
 * It also buys the look the circle layers could not: additive blending on the
 * night skin, so overlapping halos genuinely accumulate into light.
 *
 * Known limit: positions are float32 mercator, which jitters at street-level
 * zoom (~z14+). The app caps at z16 and the glow is soft; acceptable for now.
 */

import * as maplibregl from 'maplibre-gl';
import type { Category, HistoryEvent } from '../types.ts';
import type { Skin } from './skins.ts';

/** Years an event spends white-hot after ignition. Mirrors the label flare. */
const FLARE = 2.5;

const VERT = `
attribute vec2 a_pos;
attribute float a_s;
attribute float a_r;
attribute vec3 a_color;
uniform mat4 u_matrix;
uniform float u_world;
uniform float u_time;
uniform float u_span;
uniform float u_base;
uniform float u_dpr;
varying vec3 v_color;
varying float v_bright;
void main() {
  float age = u_time - a_s;
  float b = 0.0;
  if (age >= 0.0) {
    if (age < ${FLARE}) {
      b = 1.0 + (1.0 - age / ${FLARE}) * 0.35;
    } else {
      float u = (age - ${FLARE}) / max(1.0, u_span - ${FLARE});
      if (u < 1.0) b = 0.30 + 0.70 * pow(1.0 - u, 1.45);
      else b = 0.10 * exp(-(u - 1.0) * 0.55) + 0.06;
    }
  }
  float notab = 2.0 + min(a_r, 100.0) * 0.045;
  float size = u_base * notab * (0.72 + min(b, 1.4) * 0.5);
  // The custom-layer matrix maps world pixel space (mercator * 512 * 2^zoom).
  gl_Position = u_matrix * vec4(a_pos * u_world, 0.0, 1.0);
  gl_PointSize = clamp(size * u_dpr, 0.0, 96.0);
  v_color = a_color;
  v_bright = b;
}`;

const FRAG = `
precision mediump float;
varying vec3 v_color;
varying float v_bright;
uniform float u_alpha;
uniform float u_soft;
uniform float u_coreMix;
uniform float u_additive;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(p, p);
  if (d2 > 1.0) discard;
  float fall = pow(max(0.0, 1.0 - sqrt(d2)), u_soft);
  vec3 col = mix(v_color, vec3(1.0, 0.96, 0.88), u_coreMix);
  float a = clamp(v_bright, 0.0, 1.5) * u_alpha * fall;
  // Additive: premultiplied light that sums. Alpha: ordinary ink.
  if (u_additive > 0.5) gl_FragColor = vec4(col * a, 0.0);
  else gl_FragColor = vec4(col, a);
}`;

/** halo / body / core — the firefly stack, drawn back to front. */
const PASSES = [
  { mul: 5.0, soft: 2.6, alpha: 0.055, coreMix: 0.0 },
  { mul: 2.0, soft: 1.7, alpha: 0.24, coreMix: 0.12 },
  { mul: 0.8, soft: 1.1, alpha: 0.6, coreMix: 0.85 },
] as const;

export interface EmberHandle {
  /** Advance the clock. Costs one uniform; call triggerRepaint after. */
  setTime(to: number, span: number): void;
  setEvents(events: HistoryEvent[]): void;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createEmberLayer(
  id: string,
  skin: Skin,
): { layer: maplibregl.CustomLayerInterface; handle: EmberHandle } {
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let count = 0;
  let time = { to: 1950, span: 50 };
  let pendingEvents: HistoryEvent[] | null = null;
  let mapRef: maplibregl.Map | null = null;

  const loc: Record<string, WebGLUniformLocation | null> = {};
  const attr: Record<string, number> = {};

  const colorOf = (() => {
    const cache = new Map<Category, [number, number, number]>();
    return (g: Category) => {
      let c = cache.get(g);
      if (!c) {
        c = hexToRgb(skin.glow[g] ?? skin.glow.other);
        cache.set(g, c);
      }
      return c;
    };
  })();

  /** pos.x, pos.y, s, r, rgb — 7 floats per event, uploaded once. */
  function upload(events: HistoryEvent[]): void {
    if (!gl || !buffer) {
      pendingEvents = events;
      return;
    }
    const data = new Float32Array(events.length * 7);
    let i = 0;
    for (const e of events) {
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: e.c[0], lat: e.c[1] });
      const [r, g, b] = colorOf(e.g);
      data[i++] = mc.x;
      data[i++] = mc.y;
      data[i++] = e.s;
      data[i++] = e.r;
      data[i++] = r;
      data[i++] = g;
      data[i++] = b;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    count = events.length;
  }

  const layer: maplibregl.CustomLayerInterface = {
    id,
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, glCtx) {
      mapRef = map;
      gl = glCtx;
      const compile = (type: number, src: string): WebGLShader => {
        const s = glCtx.createShader(type)!;
        glCtx.shaderSource(s, src);
        glCtx.compileShader(s);
        if (!glCtx.getShaderParameter(s, glCtx.COMPILE_STATUS)) {
          throw new Error(`ember shader: ${glCtx.getShaderInfoLog(s) ?? 'compile failed'}`);
        }
        return s;
      };
      program = glCtx.createProgram()!;
      glCtx.attachShader(program, compile(glCtx.VERTEX_SHADER, VERT));
      glCtx.attachShader(program, compile(glCtx.FRAGMENT_SHADER, FRAG));
      glCtx.linkProgram(program);
      if (!glCtx.getProgramParameter(program, glCtx.LINK_STATUS)) {
        throw new Error(`ember layer: ${glCtx.getProgramInfoLog(program) ?? 'link failed'}`);
      }
      for (const u of ['u_matrix', 'u_world', 'u_time', 'u_span', 'u_base', 'u_dpr', 'u_alpha', 'u_soft', 'u_coreMix', 'u_additive']) {
        loc[u] = glCtx.getUniformLocation(program, u);
      }
      for (const a of ['a_pos', 'a_s', 'a_r', 'a_color']) {
        attr[a] = glCtx.getAttribLocation(program, a);
      }
      buffer = glCtx.createBuffer();
      if (pendingEvents) {
        upload(pendingEvents);
        pendingEvents = null;
      }
    },

    onRemove() {
      if (gl) {
        if (program) gl.deleteProgram(program);
        if (buffer) gl.deleteBuffer(buffer);
      }
      gl = null;
      program = null;
      buffer = null;
      mapRef = null;
      count = 0;
    },

    render(glCtx, options) {
      if (!program || !buffer || count === 0 || !mapRef) return;
      glCtx.useProgram(program);
      // World (mercator) space → clip space; the classic custom-layer matrix.
      const matrix = options.modelViewProjectionMatrix;
      glCtx.uniformMatrix4fv(loc['u_matrix']!, false, matrix as unknown as Float32Array);
      glCtx.uniform1f(loc['u_time']!, time.to);
      glCtx.uniform1f(loc['u_span']!, Math.max(4, time.span));
      glCtx.uniform1f(loc['u_dpr']!, Math.min(2, window.devicePixelRatio || 1));
      glCtx.uniform1f(loc['u_additive']!, skin.dark ? 1 : 0);

      // Footprint grows with zoom the way the circle layers did: 1x at z2, 2.2x at z9.
      const zoom = mapRef.getZoom();
      const zScale = 1 + Math.max(0, Math.min(1, (zoom - 2) / 7)) * 1.2;
      glCtx.uniform1f(loc['u_world']!, 512 * Math.pow(2, zoom));

      glCtx.bindBuffer(glCtx.ARRAY_BUFFER, buffer);
      const stride = 7 * 4;
      glCtx.enableVertexAttribArray(attr['a_pos']!);
      glCtx.vertexAttribPointer(attr['a_pos']!, 2, glCtx.FLOAT, false, stride, 0);
      glCtx.enableVertexAttribArray(attr['a_s']!);
      glCtx.vertexAttribPointer(attr['a_s']!, 1, glCtx.FLOAT, false, stride, 8);
      glCtx.enableVertexAttribArray(attr['a_r']!);
      glCtx.vertexAttribPointer(attr['a_r']!, 1, glCtx.FLOAT, false, stride, 12);
      glCtx.enableVertexAttribArray(attr['a_color']!);
      glCtx.vertexAttribPointer(attr['a_color']!, 3, glCtx.FLOAT, false, stride, 16);

      glCtx.enable(glCtx.BLEND);
      glCtx.disable(glCtx.DEPTH_TEST);
      if (skin.dark) glCtx.blendFunc(glCtx.ONE, glCtx.ONE);
      else glCtx.blendFunc(glCtx.SRC_ALPHA, glCtx.ONE_MINUS_SRC_ALPHA);

      for (const pass of PASSES) {
        glCtx.uniform1f(loc['u_base']!, pass.mul * zScale);
        glCtx.uniform1f(loc['u_alpha']!, pass.alpha * (skin.dark ? 1 : 0.9));
        glCtx.uniform1f(loc['u_soft']!, pass.soft);
        glCtx.uniform1f(loc['u_coreMix']!, skin.dark ? pass.coreMix : pass.coreMix * 0.4);
        glCtx.drawArrays(glCtx.POINTS, 0, count);
      }

      // Leave blending the way MapLibre expects it.
      glCtx.blendFunc(glCtx.ONE, glCtx.ONE_MINUS_SRC_ALPHA);
    },
  };

  const handle: EmberHandle = {
    setTime(to, span) {
      time = { to, span };
    },
    setEvents(events) {
      upload(events);
    },
  };

  return { layer, handle };
}
