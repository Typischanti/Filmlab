// WebGL2-Renderer: rechnet das Filmmodell (model.js) live auf der GPU.
//
// Durchgänge:
//   1. Lichter-Auszug in kleiner Auflösung (für Halation und Bloom)
//   2. Gauß-Unschärfe eng (Halation) und weit (Bloom, Halation-Ausläufer)
//   3. Hauptdurchgang in Ausgabeauflösung: Filmmodell, Korn, Lichtlecks
//
// Koordinaten: vUV ist die Ausgabeposition (0..1, y nach unten). uSrcM bildet
// sie auf die Quelle ab (Ausschnitt, Spiegelung).

import { buildUniforms } from './model.js';

const VERT = `#version 300 es
in vec2 aPos;
uniform bool uFlip;
out vec2 vUV;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  vUV = vec2(uv.x, uFlip ? uv.y : 1.0 - uv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

// Lichter-Auszug: nur helle Bildteile erzeugen sichtbare Halation.
const HIGHLIGHT = `${COMMON}
uniform sampler2D uSrc;
uniform mat3 uSrcM;
uniform float uGain;
void main() {
  vec2 st = (uSrcM * vec3(vUV, 1.0)).xy;
  vec3 c = toLinear(texture(uSrc, st).rgb) * uGain;
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = clamp((Y - 0.45) / 0.55, 0.0, 1.0);
  outColor = vec4(c * w * w, 1.0);
}`;

// Separierbare Gauß-Unschärfe: 13 Abgriffe, sigma = 3 Schritte.
const BLUR = `${COMMON}
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  vec3 s = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 18.0);
    s += texture(uTex, vUV + uStep * float(i)).rgb * w;
    wsum += w;
  }
  outColor = vec4(s / wsum, 1.0);
}`;

const MAIN = `${COMMON}
uniform sampler2D uSrc;
uniform sampler2D uHalo;
uniform sampler2D uWide;
uniform mat3 uSrcM;
uniform float uGain;
uniform mat3 uCross;
uniform float uSat;
uniform int uType;
uniform vec3 uNegG;
uniform float uLat;
uniform vec3 uPrinter;
uniform vec3 uLineG;
uniform vec3 uOffset;
uniform float uDmid;
uniform float uDmin;
uniform float uDmax;
uniform float uToe;
uniform float uShoulder;
uniform float uRk;
uniform mat3 uDye;
uniform float uGrainAmp;
uniform float uGrainCell;
uniform float uGrainColor;
uniform uint uSeed;
uniform float uHal;
uniform vec3 uHalTint;
uniform float uBloom;
uniform float uVig;
uniform vec2 uAspect;
uniform int uLeakN;
uniform vec4 uLeakA[3];
uniform vec4 uLeakC[3];

const float LOG_MID = -0.7447275;

vec3 softplus(vec3 x, float k) {
  return max(x, 0.0) + k * log(1.0 + exp(-abs(x) / k));
}

uint hash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float rnd(ivec2 p, uint ch) {
  return float(hash(uvec3(uvec2(p + 32768), ch ^ uSeed)) >> 8) * (2.0 / 16777216.0) - 1.0;
}
// Wertrauschen mit weicher Interpolation: rundliche Kornklumpen
float vnoise(vec2 p, uint ch) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 ip = ivec2(i);
  float a = rnd(ip, ch), b = rnd(ip + ivec2(1, 0), ch);
  float c = rnd(ip + ivec2(0, 1), ch), d = rnd(ip + ivec2(1, 1), ch);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float grain1(vec2 p, uint ch) {
  // zwei gegeneinander gedrehte Oktaven gegen Rasterartefakte
  vec2 q = mat2(0.8, 0.6, -0.6, 0.8) * p * 1.93 + 37.1;
  return (vnoise(p, ch) + 0.55 * vnoise(q, ch + 7u)) * 2.2;
}

vec3 leak(vec2 uv) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    if (i >= uLeakN) break;
    vec4 A = uLeakA[i];
    float d, a;
    if (A.x < 0.5) { d = uv.x; a = uv.y; }
    else if (A.x < 1.5) { d = 1.0 - uv.x; a = uv.y; }
    else if (A.x < 2.5) { d = uv.y; a = uv.x; }
    else { d = 1.0 - uv.y; a = uv.x; }
    float t = (a - A.y) / A.z;
    s += uLeakC[i].rgb * uLeakC[i].a * exp(-t * t) * exp(-d / A.w);
  }
  return s;
}

void main() {
  vec2 st = (uSrcM * vec3(vUV, 1.0)).xy;
  vec3 c = toLinear(texture(uSrc, st).rgb) * uGain;

  // Objektiv: natürliche Randabdunklung
  vec2 q = (vUV - 0.5) * uAspect;
  float r2 = dot(q, q) / dot(uAspect * 0.5, uAspect * 0.5);
  c *= 1.0 - uVig * 0.75 * r2 * (0.6 + 0.4 * r2);

  // Halation: Licht wird an der Filmrückseite reflektiert und belichtet
  // vor allem die rotempfindliche Schicht – rötlicher Saum um Lichter.
  vec3 h1 = texture(uHalo, vUV).rgb;
  vec3 h2 = texture(uWide, vUV).rgb;
  float hl = dot(h1 * 0.75 + h2 * 0.25, vec3(0.3333));
  c += uHal * hl * uHalTint;
  c += uBloom * (h2 * 0.7 + h1 * 0.3);
  c += leak(vUV);

  vec3 e = max(uCross * c, vec3(1e-5));
  vec3 u = log(e) * 0.4342945 - LOG_MID;
  float m = (u.r + u.g + u.b) / 3.0;
  u = m + (u - m) * uSat;

  vec3 n = vec3(0.0);
  if (uGrainAmp > 0.0) {
    vec2 p = gl_FragCoord.xy / uGrainCell;
    float l = grain1(p, 1u);
    vec3 col = vec3(grain1(p, 2u), grain1(p, 3u), grain1(p, 4u));
    n = mix(vec3(l), col, uGrainColor);
  }

  vec3 Dl;
  if (uType == 1) {
    Dl = uDmid - uLineG * u + uOffset;
    Dl += uGrainAmp * n * (0.35 + sqrt(max(Dl - uDmin, 0.0)));
  } else {
    vec3 dn = uNegG * softplus(u + uLat, 0.3);
    dn = 2.6 - softplus(2.6 - dn, 0.3);
    dn += uGrainAmp * n * (0.35 + sqrt(max(dn, 0.0)));
    Dl = uDmid + uLineG * (uPrinter - dn);
  }
  vec3 D = uDmin + softplus(Dl - uDmin, uToe);
  D = uDmax - softplus(uDmax - D, uShoulder);
  D = uDye * D;
  vec3 lin = (pow(vec3(10.0), -(D - uDmin)) - uRk) / (1.0 - uRk);
  vec3 o = toSrgb(clamp(lin, 0.0, 1.0));
  // Dithering gegen Tonwertabrisse in 8 Bit
  o += (rnd(ivec2(gl_FragCoord.xy), 99u) * 0.5) / 255.0;
  outColor = vec4(o, 1.0);
}`;

const LOW_HALO = 480; // lange Seite des Halation-Puffers
const LOW_WIDE = 120; // lange Seite des Bloom-Puffers

function mat3RowsToGl(m) {
  // GLSL erwartet spaltenweise Ablage
  return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
}

export class FilmRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 wird nicht unterstützt.');
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.progHighlight = this.program(HIGHLIGHT);
    this.progBlur = this.program(BLUR);
    this.progMain = this.program(MAIN);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.srcTex = this.texture();
    this.srcW = 0;
    this.srcH = 0;
    this.targets = {};
    this.uniformCache = new Map();
  }

  program(fragSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const locs = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      locs[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, locs };
  }

  texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // Quelle hochladen (Video, Bild, Canvas, ImageBitmap). Mipmaps verhindern
  // Flimmern, wenn eine große Quelle verkleinert dargestellt wird.
  setSource(el, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.srcW = w;
    this.srcH = h;
  }

  target(name, w, h, float) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (t) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    const tex = this.texture();
    if (float && this.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fb, w, h };
    this.targets[name] = t;
    return t;
  }

  draw(prog, target, w, h, flip) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.uniform1i(prog.locs.uFlip, flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Ausschnitt der Quelle (Pixel) -> Matrix Ausgabe-UV -> Quell-UV.
  srcMatrix(crop, mirror) {
    const sx = crop.w / this.srcW, sy = crop.h / this.srcH;
    const ox = crop.x / this.srcW, oy = crop.y / this.srcH;
    // spaltenweise: [a 0 0; 0 d 0; tx ty 1]
    return mirror
      ? new Float32Array([-sx, 0, 0, 0, sy, 0, ox + sx, oy, 1])
      : new Float32Array([sx, 0, 0, 0, sy, 0, ox, oy, 1]);
  }

  // Rendert die aktuelle Quelle. out: { w, h, fbo?: bool }.
  render(settings, crop, out, opts = {}) {
    const gl = this.gl;
    const { w, h } = out;
    const U = buildUniforms(settings, { shortSide: Math.min(w, h) });
    const M = this.srcMatrix(crop, opts.mirror);
    gl.bindVertexArray(this.vao);
    // Zwischenpuffer lösen, bevor in sie geschrieben wird (sonst Rückkopplung)
    for (const unit of [1, 2]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);

    // 1. Lichter-Auszug in kleiner Auflösung
    const k = LOW_HALO / Math.max(w, h);
    const lw = Math.max(8, Math.round(w * k)), lh = Math.max(8, Math.round(h * k));
    const k2 = LOW_WIDE / Math.max(w, h);
    const ww = Math.max(4, Math.round(w * k2)), wh = Math.max(4, Math.round(h * k2));
    const needBlur = U.halation > 0 || U.bloom > 0;
    const halo = this.target('haloA', lw, lh, true);
    const haloB = this.target('haloB', lw, lh, true);
    const wide = this.target('wideA', ww, wh, true);
    const wideB = this.target('wideB', ww, wh, true);

    if (needBlur) {
      let P = this.progHighlight;
      gl.useProgram(P.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.uniform1i(P.locs.uSrc, 0);
      gl.uniformMatrix3fv(P.locs.uSrcM, false, M);
      gl.uniform1f(P.locs.uGain, U.gain);
      this.draw(P, halo, lw, lh, true);
      this.draw(P, wide, ww, wh, true);

      // 2. Unschärfe: Radius als Anteil der kurzen Bildseite
      P = this.progBlur;
      gl.useProgram(P.p);
      gl.uniform1i(P.locs.uTex, 0);
      const blur = (a, b, bw, bh, sigmaFrac) => {
        const sigma = Math.max(0.6, sigmaFrac * Math.min(bw, bh));
        const s = sigma / 3; // Kernel: sigma = 3 Schritte
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.uniform2f(P.locs.uStep, s / bw, 0);
        this.draw(P, b, bw, bh, true);
        gl.bindTexture(gl.TEXTURE_2D, b.tex);
        gl.uniform2f(P.locs.uStep, 0, s / bh);
        this.draw(P, a, bw, bh, true);
      };
      blur(halo, haloB, lw, lh, U.halationRadius);
      blur(halo, haloB, lw, lh, U.halationRadius * 0.7);
      blur(wide, wideB, ww, wh, U.halationRadius * 3.5);
      blur(wide, wideB, ww, wh, U.halationRadius * 3.5);
    } else {
      for (const t of [halo, wide]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    // 3. Hauptdurchgang (Ziel zuerst anlegen: das bindet eine Textur)
    const outTarget = out.fbo ? this.target('out', w, h, false) : null;
    const P = this.progMain;
    const L = P.locs;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(L.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, halo.tex);
    gl.uniform1i(L.uHalo, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, wide.tex);
    gl.uniform1i(L.uWide, 2);
    gl.activeTexture(gl.TEXTURE0);

    gl.uniformMatrix3fv(L.uSrcM, false, M);
    gl.uniform1f(L.uGain, U.gain);
    gl.uniformMatrix3fv(L.uCross, false, mat3RowsToGl(U.cross));
    gl.uniform1f(L.uSat, U.sat);
    gl.uniform1i(L.uType, U.type);
    gl.uniform3fv(L.uNegG, U.negG);
    gl.uniform1f(L.uLat, U.lat);
    gl.uniform3fv(L.uPrinter, U.printer);
    gl.uniform3fv(L.uLineG, U.lineG);
    gl.uniform3fv(L.uOffset, U.offset);
    gl.uniform1f(L.uDmid, U.dmid);
    gl.uniform1f(L.uDmin, U.dmin);
    gl.uniform1f(L.uDmax, U.dmax);
    gl.uniform1f(L.uToe, U.toe);
    gl.uniform1f(L.uShoulder, U.shoulder);
    gl.uniform1f(L.uRk, U.rk);
    gl.uniformMatrix3fv(L.uDye, false, mat3RowsToGl(U.dye));
    gl.uniform1f(L.uGrainAmp, U.grainAmp);
    gl.uniform1f(L.uGrainCell, U.grainCell);
    gl.uniform1f(L.uGrainColor, U.grainColor);
    gl.uniform1ui(L.uSeed, (opts.seed ?? U.seed) >>> 0);
    gl.uniform1f(L.uHal, needBlur ? U.halation : 0);
    gl.uniform3fv(L.uHalTint, U.halationTint);
    gl.uniform1f(L.uBloom, needBlur ? U.bloom : 0);
    gl.uniform1f(L.uVig, U.vignette);
    const ar = w / h;
    gl.uniform2f(L.uAspect, ar >= 1 ? ar : 1, ar >= 1 ? 1 : 1 / ar);
    const leaks = U.leaks.slice(0, 3);
    gl.uniform1i(L.uLeakN, leaks.length);
    if (leaks.length) {
      const A = new Float32Array(12), C = new Float32Array(12);
      leaks.forEach((lk, i) => {
        A.set([lk.side, lk.pos, lk.width, lk.depth], i * 4);
        C.set([...lk.color, lk.intensity], i * 4);
      });
      gl.uniform4fv(L.uLeakA, A);
      gl.uniform4fv(L.uLeakC, C);
    }

    if (outTarget) {
      this.draw(P, outTarget, w, h, true);
      return outTarget;
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.draw(P, null, w, h, false);
    return null;
  }

  // In voller Auflösung in einen Framebuffer rendern und auslesen.
  renderToImageData(settings, crop, w, h, opts = {}) {
    const gl = this.gl;
    const max = Math.min(this.maxTex, 8192);
    if (w > max || h > max) throw new Error('Bild zu groß für die GPU.');
    const t = this.render(settings, crop, { w, h, fbo: true }, opts);
    const data = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Ausgabeziel wieder freigeben, es kann sehr groß sein
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
    delete this.targets.out;
    return new ImageData(data, w, h);
  }
}
