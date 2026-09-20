/* LLM Bench — 玻璃折射 Hero（原生 WebGL1，零依赖）
   复刻 Spline「Distorting Typography」的视觉机制：
   近黑底 + 巨型排版 + 玻璃透镜球跟随鼠标
   （中心放大折射 → 边缘压缩 → 菲涅尔亮边 → 高光 → 轻微色差）
   WebGL 不可用时降级为纯文字层；prefers-reduced-motion 时静止渲染。 */
(function () {
  'use strict';

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uRes;
    uniform vec4 uS[3];          // x, y, radius（设备像素）
    varying vec2 vUv;

    void main() {
      vec2 px = vUv * uRes;
      vec3 col = vec3(0.0);
      float alpha = 0.0;              // 球体外保持透明（logo 场景需要）

      for (int i = 0; i < 3; i++) {
        vec4 s = uS[i];
        vec2 d = px - s.xy;
        float r = length(d) / max(s.z, 1.0);
        if (r < 1.0 && s.z > 0.0) {
          vec2 dir = length(d) > 0.001 ? d / length(d) : vec2(0.0);
          float nz = sqrt(1.0 - r * r);                    // 球面法线 z
          // 透镜采样半径：中心强放大（0.32R）→ 边缘压缩（0.62R）
          float k = r * (0.62 - 0.30 * nz);
          // 色差：越靠边缘 RGB 采样半径越错开（玻璃色散）
          float ca = 0.045 * smoothstep(0.45, 1.0, r);
          vec3 ref;
          ref.r = texture2D(uTex, (s.xy + dir * k * s.z * (1.0 + ca)) / uRes).r;
          ref.g = texture2D(uTex, (s.xy + dir * k * s.z) / uRes).g;
          ref.b = texture2D(uTex, (s.xy + dir * k * s.z * (1.0 - ca)) / uRes).b;
          // 玻璃体感：提亮 + 右下内部暗影
          vec3 glass = ref * 1.12 + vec3(0.012);
          float shade = clamp(dot(dir, vec2(0.55, 0.75)) * 0.5 + 0.5, 0.0, 1.0);
          glass *= 1.0 - 0.38 * smoothstep(0.25, 1.0, r) * shade;
          // 左上高光
          glass += exp(-pow(length(d - s.z * vec2(-0.34, -0.38)) / (s.z * 0.30), 2.0)) * 0.20;
          // 菲涅尔边缘 + 细亮环
          float rim = smoothstep(0.60, 1.0, r);
          glass += rim * rim * 0.34;
          glass += smoothstep(0.94, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r)) * 0.55;
          // 底部反光弧（呼应 Spline 的冷色散）
          glass += vec3(0.045, 0.02, 0.06) * smoothstep(0.72, 0.95, r) * (1.0 - shade);
          col = glass;
          alpha = max(alpha, smoothstep(1.0, 0.965, r));   // 边缘 1px 抗锯齿
        }
      }
      // 暗角（对所有像素做，避免球内过曝）
      col *= 1.0 - 0.20 * pow(length(vUv - 0.5) * 1.35, 2.0);
      gl_FragColor = vec4(col, alpha);
    }
  `;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  }

  function drawTextLayer(w, h, lines, bright) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    // 底：中心略亮的近黑（呼应 Spline 的环境光）
    // bright=true（logo 场景）：给玻璃球一层明亮的可折射内容，球体才像"实心白色玻璃"而非空心环
    const g = ctx.createRadialGradient(w * 0.42, h * 0.30, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.85);
    if (bright) {
      g.addColorStop(0, '#c9ccd6');
      g.addColorStop(0.45, '#5c606c');
      g.addColorStop(1, '#0c0d11');
    } else {
      g.addColorStop(0, '#191920');
      g.addColorStop(0.55, '#0e0e11');
      g.addColorStop(1, '#070708');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // 无文字（logo 场景）：只留底色，球体折射这层亮底成像
    if (!lines.length) return cv;
    // 巨型排版：占上部 62%，随行数自适应，超宽整体缩小
    const n = lines.length;
    const areaH = h * 0.62;
    let fontSize = (areaH / n) * 0.80;
    const setFont = (size) => {
      ctx.font = `800 ${size}px -apple-system, "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif`;
    };
    setFont(fontSize);
    let widest = 0;
    for (const ln of lines) widest = Math.max(widest, ctx.measureText(ln).width);
    const maxW = w * 0.92;
    if (widest > maxW) fontSize *= maxW / widest;
    setFont(fontSize);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try { ctx.letterSpacing = `${Math.round(fontSize * -0.022)}px`; } catch (e) { /* 老浏览器忽略 */ }
    const lineH = areaH / n;
    const startY = h * 0.05 + lineH / 2;
    ctx.shadowColor = 'rgba(255,255,255,.30)';
    ctx.shadowBlur = fontSize * 0.20;
    ctx.fillStyle = '#d7d7da';
    lines.forEach((ln, i) => ctx.fillText(ln, w / 2, startY + i * lineH));
    return cv;
  }

  function mount(canvas, opts) {
    opts = opts || {};
    const lines = opts.lines || ['LLM BENCH!'];
    const bright = !!opts.bright;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl', { antialias: true, alpha: true, premultipliedAlpha: false });

    const reduceMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- WebGL 不可用：降级为 2D 文字层（无球） ---
    if (!gl) {
      const ctx2d = canvas.getContext('2d');
      const render2d = () => {
        const d = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = Math.max(1, Math.round(canvas.clientWidth * d));
        const h = Math.max(1, Math.round(canvas.clientHeight * d));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        ctx2d.drawImage(drawTextLayer(w, h, lines, bright), 0, 0);
      };
      render2d();
      return { destroy() {} };
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('program link failed');
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uS = gl.getUniformLocation(prog, 'uS');
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 画布行序与 WebGL 纹理坐标相反，必须翻转，否则整幅画面上下颠倒
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

    // 球体定义：半径相对 min(w,h)，异速跟随 + 各自漂浮 + 相对鼠标的簇拥偏移
    const defs = opts.spheres || [
      { r: 0.215, hx: 0.30, hy: 0.34, follow: 0.085, drift: 14, ox: 0, oy: 0 },
      { r: 0.145, hx: 0.60, hy: 0.56, follow: 0.05, drift: 10, ox: -130, oy: 95 },
      { r: 0.088, hx: 0.74, hy: 0.30, follow: 0.135, drift: 18, ox: 95, oy: 150 },
    ];
    const spheres = defs.map((d) => ({ ...d, x: 0, y: 0, tx: 0, ty: 0, init: false }));

    let W = 0, H = 0, dpr = 1;
    let mouse = null;
    let raf = 0, running = false;
    const t0 = performance.now();

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = Math.max(1, Math.round(canvas.clientWidth * dpr));
      H = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawTextLayer(W, H, lines, bright));
      gl.uniform2f(uRes, W, H);
      spheres.forEach((s) => {
        if (!s.init) { s.x = W * s.hx; s.y = H * s.hy; s.tx = s.x; s.ty = s.y; s.init = true; }
      });
    }

    const arr = new Float32Array(12);
    function frame(now) {
      raf = 0;
      const t = (now - t0) / 1000;
      spheres.forEach((s, i) => {
        if (mouse) {
          s.tx = (mouse.x + s.ox) * dpr;
          s.ty = (mouse.y + s.oy) * dpr;
        } else {
          s.tx = W * s.hx + Math.sin(t * 0.45 + i * 2.1) * s.drift * dpr;
          s.ty = H * s.hy + Math.cos(t * 0.38 + i * 1.7) * s.drift * dpr;
        }
        s.x += (s.tx - s.x) * s.follow;
        s.y += (s.ty - s.y) * s.follow;
        arr[i * 4] = s.x;
        arr[i * 4 + 1] = s.y;
        arr[i * 4 + 2] = Math.min(W, H) * s.r;
        arr[i * 4 + 3] = 0;
      });
      gl.uniform4fv(uS, arr);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (running && !reduceMotion) raf = requestAnimationFrame(frame);
    }

    function renderOnce() { if (!raf) frame(performance.now()); }
    function start() { if (!running && !reduceMotion) { running = true; raf = requestAnimationFrame(frame); } }
    function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    const ro = new ResizeObserver(() => { resize(); renderOnce(); });
    ro.observe(canvas);
    const onWinResize = () => { resize(); renderOnce(); };
    window.addEventListener('resize', onWinResize);
    resize();
    // 首帧后再校准一次：挂载时若尚未完成布局，clientWidth 会是 0
    requestAnimationFrame(() => { resize(); renderOnce(); });

    const io = new IntersectionObserver((es) => {
      const vis = es.some((e) => e.isIntersecting);
      if (vis && !reduceMotion) start(); else stop();
    }, { threshold: 0.02 });
    io.observe(canvas);

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onLeave = () => { mouse = null; };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    renderOnce();
    if (!reduceMotion) start();

    return {
      destroy() {
        stop();
        ro.disconnect(); io.disconnect();
        window.removeEventListener('resize', onWinResize);
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('mouseleave', onLeave);
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      },
    };
  }

  window.GlassHero = { mount };
})();
