globalThis.VA = globalThis.VA || {};
VA.waveform = (function () {
  var BUCKET_SAMPLES = 256;   // 固定缓存粒度：10 分钟素材约 10 万桶，<1MB，缩放无需重算

  function computePeaks(channels, sampleRate) {
    var n = channels[0].length;
    var numCh = channels.length;
    var buckets = Math.max(1, Math.ceil(n / BUCKET_SAMPLES));
    var min = new Float32Array(buckets);
    var max = new Float32Array(buckets);
    for (var b = 0; b < buckets; b++) {
      var s = b * BUCKET_SAMPLES;
      var e = Math.min(n, s + BUCKET_SAMPLES);
      var lo = Infinity, hi = -Infinity;
      for (var i = s; i < e; i++) {
        var v = 0;
        for (var c = 0; c < numCh; c++) v += channels[c][i];
        v /= numCh;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!(lo <= hi)) { lo = 0; hi = 0; }   // 空桶或 NaN
      min[b] = lo; max[b] = hi;
    }
    return { min: min, max: max, buckets: buckets };
  }

  // 把峰值桶聚合到当前缩放下的逐像素包络。纯读，不修改 peaks。
  function buildFrame(peaks, sampleRate, pps, viewStartSec, widthPx) {
    var bucketsPerSec = sampleRate / BUCKET_SAMPLES;
    var outMin = new Float32Array(widthPx);
    var outMax = new Float32Array(widthPx);
    var maxStart = Math.max(0, (peaks.buckets / bucketsPerSec) - widthPx / pps);
    var viewStart = Math.max(0, Math.min(viewStartSec || 0, maxStart));
    for (var px = 0; px < widthPx; px++) {
      var t0 = viewStart + px / pps;
      var t1 = t0 + 1 / pps;
      var b0 = Math.floor(t0 * bucketsPerSec);
      var b1 = Math.ceil(t1 * bucketsPerSec);
      if (b1 <= b0) b1 = b0 + 1;
      if (b0 >= peaks.buckets) { outMin[px] = 0; outMax[px] = 0; continue; }
      if (b1 > peaks.buckets) b1 = peaks.buckets;
      var lo = Infinity, hi = -Infinity;
      for (var b = b0; b < b1; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      outMin[px] = lo === Infinity ? 0 : lo;
      outMax[px] = hi === -Infinity ? 0 : hi;
    }
    outMin.viewStart = viewStart;
    return { min: outMin, max: outMax, viewStart: viewStart };
  }

  function timeToX(t, pps, viewStart) { return (t - (viewStart || 0)) * pps; }
  function xToTime(px, pps, viewStart) { return (viewStart || 0) + px / pps; }

  // 把手优先；其次区间内拖动；否则视为新建选段。
  // 空选段（宽 0，拖拽中途的正常状态）必须**先**短路成 'new'：否则把手判定 |px-start|<=handlePx
  // 会在起点上返回 'start'，与 Step 1 最后一条用例冲突，且零宽选段将无法通过拖拽重新起段。
  function hitTarget(px, selRect, handlePx) {
    if (!(selRect.end > selRect.start)) return 'new';
    if (Math.abs(px - selRect.start) <= handlePx) return 'start';
    if (Math.abs(px - selRect.end) <= handlePx) return 'end';
    if (px >= selRect.start && px <= selRect.end) return 'range';
    return 'new';
  }

  var HANDLE_PX = 6;
  var RULER_H = 20;

  function allChannels(buf) {
    var arr = [];
    for (var i = 0; i < buf.numberOfChannels; i++) arr.push(buf.getChannelData(i));
    return arr;
  }

  function mount(canvas, buffer, opts) {
    var ctx2d = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var peaks = computePeaks(allChannels(buffer), buffer.sampleRate);
    var state = {
      pps: 80,
      viewStart: 0,
      widthPx: 0,
      selection: { start: 0, end: 0 },
      playhead: -1
    };
    var dragging = null;   // {target, anchor, from}
    var onChange = (opts && opts.onChange) || function () {};
    var onViewport = (opts && opts.onViewport) || function () {};
    if (opts && opts.recipe) state.selection = { start: opts.recipe.selection.start, end: opts.recipe.selection.end };

    function resize() {
      var cssW = canvas.clientWidth || 1200;
      var cssH = canvas.clientHeight || 220;
      state.widthPx = Math.max(1, Math.floor(cssW * dpr));
      canvas.width = state.widthPx;
      canvas.height = Math.floor(cssH * dpr);
      redraw();
    }

    function viewStartSec() { return state.viewStart; }
    function pps() { return state.pps * dpr; }

    function selRectPx() {
      return {
        start: timeToX(state.selection.start, pps(), viewStartSec()),
        end: timeToX(state.selection.end, pps(), viewStartSec())
      };
    }

    function redraw() {
      var W = state.widthPx, H = canvas.height;
      var waveH = H - RULER_H * dpr;
      ctx2d.clearRect(0, 0, W, H);

      // 背景
      ctx2d.fillStyle = getCss('--panel-2') || '#20262f';
      ctx2d.fillRect(0, 0, W, H);

      var frame = buildFrame(peaks, buffer.sampleRate, pps(), viewStartSec(), W);

      // 未选中区
      drawEnvelope(frame, W, waveH, getCss('--line') || '#2b333f');
      // 选中区高亮：裁剪到选段范围再画一遍
      var sr = selRectPx();
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(Math.min(sr.start, sr.end), 0, Math.abs(sr.end - sr.start), H);
      ctx2d.clip();
      drawEnvelope(frame, W, waveH, getCss('--accent') || '#5ad1c4');
      ctx2d.restore();

      drawRuler(W, H, waveH);
      drawSelection(sr, waveH);
      drawPlayhead(W, H);
    }

    function drawEnvelope(frame, W, waveH, color) {
      var mid = waveH / 2, scale = waveH / 2 * 0.9;
      ctx2d.fillStyle = color;
      for (var x = 0; x < W; x++) {
        var top = mid - frame.max[x] * scale;
        var bot = mid - frame.min[x] * scale;
        if (bot - top < 1) bot = top + 1;
        ctx2d.fillRect(x, top, 1, bot - top);
      }
    }

    function drawRuler(W, H, waveH) {
      var step = niceStep(pps());
      ctx2d.fillStyle = getCss('--panel') || '#1a1f27';
      ctx2d.fillRect(0, waveH, W, H - waveH);
      ctx2d.strokeStyle = getCss('--line') || '#2b333f';
      ctx2d.fillStyle = getCss('--ink-mute') || '#6b7684';
      ctx2d.font = (11 * dpr) + 'px system-ui, sans-serif';
      ctx2d.lineWidth = 1;
      var t0 = Math.ceil(viewStartSec() / step) * step;
      // 必须同时受时长封顶：低倍缩放（缩放下拉里就有 pps=40）时视口比整段音频还宽，
      // 只靠 `x > W` 会一路画出越过末尾的刻度与网格线。
      for (var t = t0; t <= buffer.duration; t += step) {
        var x = Math.round(timeToX(t, pps(), viewStartSec())) + 0.5;
        if (x > W) break;
        if (x < 0) continue;
        ctx2d.beginPath();
        ctx2d.moveTo(x, waveH);
        ctx2d.lineTo(x, H);
        ctx2d.stroke();
        ctx2d.fillText(fmtTime(t), x + 4 * dpr, waveH + 14 * dpr);
      }
    }

    function niceStep(actualPps) {
      var targets = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      for (var i = 0; i < targets.length; i++) {
        if (targets[i] * actualPps >= 70 * dpr) return targets[i];
      }
      return 1200;
    }

    function fmtTime(t) {
      if (t < 60) return (Math.round(t * 100) / 100) + 's';
      var m = Math.floor(t / 60), s = Math.round(t % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function drawSelection(sr, waveH) {
      var lo = Math.min(sr.start, sr.end), hi = Math.max(sr.start, sr.end);
      ctx2d.strokeStyle = getCss('--accent') || '#5ad1c4';
      ctx2d.lineWidth = 1 * dpr;
      // 只画到波形区，不穿进底部刻度条（否则竖线会和时间标签叠在一起）
      ctx2d.beginPath(); ctx2d.moveTo(lo, 0); ctx2d.lineTo(lo, waveH); ctx2d.stroke();
      ctx2d.beginPath(); ctx2d.moveTo(hi, 0); ctx2d.lineTo(hi, waveH); ctx2d.stroke();
      // 把手：垂直居中于**波形中线**，不是整块画布中线（画布含底部刻度条，用 H 会偏低）
      ctx2d.fillStyle = getCss('--accent') || '#5ad1c4';
      var hw = 3 * dpr, hh = 16 * dpr;
      ctx2d.fillRect(lo - hw, waveH / 2 - hh / 2, hw * 2, hh);
      ctx2d.fillRect(hi - hw, waveH / 2 - hh / 2, hw * 2, hh);
    }

    function drawPlayhead(W, H) {
      if (state.playhead < 0) return;
      var x = timeToX(state.playhead, pps(), viewStartSec());
      if (x < 0 || x > W) return;
      ctx2d.fillStyle = getCss('--warn') || '#f0b429';
      ctx2d.fillRect(Math.round(x) - (dpr | 0), 0, Math.max(1, dpr), H);
    }

    function getCss(name) {
      return getComputedStyle(document.body).getPropertyValue(name).trim();
    }

    function emit() {
      onChange({ start: state.selection.start, end: state.selection.end });
    }

    // 拖拽路径的夹紧：只保证顺序与边界，**允许零宽选段**。
    // 绝不能改用最外层 VA.edit.clampRecipe —— 那个函数把空段/反向段退回整段，
    // 会让"按下鼠标"这一步立刻把选段撑满全曲，拖出来的结果就是错的。
    function clampSel() {
      var a = state.selection.start, b = state.selection.end;
      var lo = Math.min(a, b), hi = Math.max(a, b);
      state.selection = {
        start: Math.max(0, Math.min(lo, buffer.duration)),
        end: Math.max(0, Math.min(hi, buffer.duration))
      };
    }

    function pointerTime(ev) {
      var rect = canvas.getBoundingClientRect();
      return xToTime((ev.clientX - rect.left) * dpr, pps(), viewStartSec());
    }

    // 记下所有绑定，destroy() 才能真解开。app.js 会在同一个 canvas 元素上反复
    // mount（换文件时），解不开就会叠加多份监听器、拖一次动好几下。
    var bound = [];
    function on(type, fn, o) {
      canvas.addEventListener(type, fn, o);
      bound.push([type, fn, o]);
    }

    on('pointerdown', function (ev) {
      var rect = canvas.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * dpr;
      var target = hitTarget(px, selRectPx(), HANDLE_PX * dpr);
      var t = pointerTime(ev);
      if (target === 'new') {
        state.selection = { start: t, end: t };
        dragging = { target: 'end' };
      } else if (target === 'range') {
        dragging = { target: 'range', anchor: t, from: { start: state.selection.start, end: state.selection.end } };
      } else {
        dragging = { target: target };
        if (target === 'start') state.selection.start = t;
        else state.selection.end = t;
      }
      clampSel(); emit(); redraw();
      // 先立元素级标记，再尝试捕获指针：setPointerCapture 对非活动/伪造 pointerId 会抛
      // NotFoundError，若它在标记之前抛出，这次拖拽就静默死掉（move 全被忽略）。
      canvas.dataset.dragging = '1';
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 捕获失败不影响本地拖拽 */ }
    });

    on('pointermove', function (ev) {
      // 两个条件都要查：dataset 是跨 mount 的元素级标记，dragging 是本控制器的私有状态。
      // 只看 dataset 时，上一次 mount 残留的标记会让本次 mount 在 dragging===null 上抛错。
      if (!dragging || !canvas.dataset.dragging) return;
      var t = pointerTime(ev);
      if (dragging.target === 'range') {
        var d = t - dragging.anchor;
        var span = dragging.from.end - dragging.from.start;
        var ns = Math.max(0, Math.min(dragging.from.start + d, buffer.duration - span));
        state.selection = { start: ns, end: ns + span };
      } else if (dragging.target === 'start') {
        state.selection.start = t;
      } else {
        state.selection.end = t;
      }
      clampSel(); emit(); redraw();
    });

    function endDrag(ev) {
      if (!canvas.dataset.dragging) return;
      delete canvas.dataset.dragging;
      dragging = null;
      if (ev && ev.pointerId !== undefined && canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) {
        canvas.releasePointerCapture(ev.pointerId);
      }
    }
    on('pointerup', endDrag);
    on('pointercancel', endDrag);

    on('wheel', function (ev) {
      ev.preventDefault();
      if (ev.ctrlKey) {
        // Ctrl+滚轮 = 以 1.25× 步进缩放（放大/缩小），保持视口起点不变。
        // 用 Ctrl 而不是 Shift：Ctrl+滚轮是"缩放"的通用手势（地图/画布类工具都这么用），
        // 且触控板双指捏合在浏览器里本来就上报 ctrlKey，于是捏合天然也是缩放。
        // 前提是这个监听器必须 { passive: false } —— 否则 preventDefault 无效，
        // Chrome 会把它当成页面缩放手势。
        var factor = ev.deltaY < 0 ? 1.25 : 0.8;
        setZoom(state.pps * factor, state.viewStart);
      } else {
        setZoom(state.pps, state.viewStart + (ev.deltaY || ev.deltaX) / state.pps);
      }
    }, { passive: false });

    function setZoom(ppsCss, vs) {
      if (ppsCss) state.pps = Math.max(1, Math.min(4000, ppsCss));
      var span = state.widthPx / pps();
      var maxView = Math.max(0, buffer.duration - span);
      state.viewStart = Math.max(0, Math.min(vs === undefined ? state.viewStart : vs, maxView));
      onViewport(state.pps, state.viewStart);
      redraw();
    }

    function fitWindow() {
      var cssW = canvas.clientWidth || 1200;
      state.pps = Math.max(0.1, cssW / Math.max(0.001, buffer.duration));
      state.viewStart = 0;
      onViewport(state.pps, state.viewStart);
      redraw();
    }

    resize();
    fitWindow();

    var ro = window.ResizeObserver ? new ResizeObserver(function () { resize(); }) : null;
    if (ro) ro.observe(canvas);

    return {
      redraw: redraw,
      resize: resize,
      setSelection: function (s) { state.selection = { start: s.start, end: s.end }; clampSel(); redraw(); },
      setZoom: setZoom,
      setPlayhead: function (t) { state.playhead = t; redraw(); },
      fitWindow: fitWindow,
      xToTime: function (px) { return xToTime(px, pps(), viewStartSec()); },
      timeToX: function (t) { return timeToX(t, pps(), viewStartSec()); },
      getPps: function () { return state.pps; },
      getViewStart: function () { return state.viewStart; },
      destroy: function () {
        for (var i = 0; i < bound.length; i++) canvas.removeEventListener(bound[i][0], bound[i][1], bound[i][2]);
        bound.length = 0;
        if (ro) ro.disconnect();
        // 拖拽中途被 destroy（Task 7 换文件正是这条路径）必须抹掉元素级标记，
        // 否则同画布上的下一个 mount 会把它当作"上次没拖完"，在自己的 dragging 还是 null 时崩。
        delete canvas.dataset.dragging;
        dragging = null;
      },
      peaks: peaks
    };
  }

  return {
    BUCKET_SAMPLES: BUCKET_SAMPLES,
    computePeaks: computePeaks,
    buildFrame: buildFrame,
    timeToX: timeToX,
    xToTime: xToTime,
    hitTarget: hitTarget,
    mount: mount
  };
})();

if (typeof module === 'object' && module.exports) module.exports = VA.waveform;
