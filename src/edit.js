globalThis.VA = globalThis.VA || {};
VA.edit = (function () {
  var EPS = 1e-9;

  function num(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }

  // 把任意用户输入归一成合法配方：选段落在 [0,duration]、start<end、淡入淡出不重叠。
  // 注意：这是"用户手填参数"路径的归一策略——空段/反向段一律退回整段（spec §7）。
  // 波形拖拽路径**不调用**本函数（拖拽中途选段宽度天然为 0，见 Task 6 的 clampSel）。
  function clampRecipe(recipe, duration) {
    var r = recipe || {};
    var sel = r.selection || {};
    var s = num(sel.start, 0);
    var e = num(sel.end, duration);
    if (duration <= 0) { s = 0; e = 0; }
    else if (e - s < EPS) { s = 0; e = duration; }   // 空段或反向段：退回整段
    var start = Math.max(0, Math.min(s, duration));
    var end = Math.max(start + EPS, Math.min(e, duration));
    var half = (end - start) / 2;
    return {
      selection: { start: start, end: end },
      gain: Math.max(0, num(r.gain, 1)),
      fadeIn: Math.max(0, Math.min(num(r.fadeIn, 0), half)),
      fadeOut: Math.max(0, Math.min(num(r.fadeOut, 0), half))
    };
  }

  function envelope(i, n, fadeInN, fadeOutN) {
    var g = 1;
    if (fadeInN > 0 && i < fadeInN) g = g * (i / fadeInN);
    if (fadeOutN > 0 && i > n - fadeOutN - 1) g = g * ((n - i - 1) / fadeOutN);
    return g;
  }

  // channelsData: Float32Array[]（源声道），recipe: 用户配方。纯函数，不碰 DOM 也不碰 WebAudio。
  function render(channelsData, sampleRate, recipe) {
    var total = channelsData[0].length;
    var duration = total / sampleRate;
    var r = clampRecipe(recipe, duration);
    var s0 = Math.floor(r.selection.start * sampleRate);
    var s1 = Math.ceil(r.selection.end * sampleRate);
    if (s1 > total) s1 = total;
    var n = Math.max(0, s1 - s0);
    var fadeInN = Math.floor(r.fadeIn * sampleRate);
    var fadeOutN = Math.floor(r.fadeOut * sampleRate);
    var out = [];
    for (var c = 0; c < channelsData.length; c++) {
      var src = channelsData[c];
      var dst = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        dst[i] = src[s0 + i] * r.gain * envelope(i, n, fadeInN, fadeOutN);
      }
      out.push(dst);
    }
    return { channels: out, sampleRate: sampleRate, frames: n, recipe: r };
  }

  return { clampRecipe: clampRecipe, render: render, envelope: envelope };
})();

if (typeof module === 'object' && module.exports) module.exports = VA.edit;
