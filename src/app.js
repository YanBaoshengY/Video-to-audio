globalThis.VA = globalThis.VA || {};
VA.app = (function () {
  var state = {
    file: null,
    buffer: null,
    state: 'empty',
    recipe: { selection: { start: 0, end: 0 }, gain: 1, fadeIn: 0, fadeOut: 0 },
    zoom: { pps: 80, viewStart: 0 }
  };
  var el = {};
  var controller = null;
  var player = null;   // Task 8 起在 finishLoad 里赋值；reset() 依赖它释放 buffer 引用
  // 载入代号：解码途中再拖一个文件时，旧回调必须作废。否则旧文件的 finishLoad 会把
  // 新文件的 controller 直接覆盖掉——destroy 漏一次，同一个 canvas 挂两次。
  var loadSeq = 0;

  function q(id) { return document.getElementById(id); }

  function setState(s) {
    state.state = s;
    document.body.dataset.state = s;
    q('panel-wave').hidden = (s === 'empty' || s === 'decoding');
    q('panel-params').hidden = (s === 'empty' || s === 'decoding');
    // 不放 decoding 的透明度：styles.css 已有 body[data-state="decoding"] .drop-zone{opacity:.55}，
    // 这里再写内联 style 等于同一件事两处口径，还会留下擦不掉的脏内联样式。
  }

  function showMessage(text) {
    el.bannerText.textContent = text;
    el.banner.hidden = false;
  }
  function hideMessage() { el.banner.hidden = true; }

  function showGate(text, onYes, onNo) {
    el.gateText.textContent = text;
    el.gate.hidden = false;
    el.gateYes.onclick = function () { closeGate(); onYes(); };
    el.gateNo.onclick = function () { closeGate(); onNo(); };
  }
  function closeGate() { el.gate.hidden = true; el.gateYes.onclick = null; el.gateNo.onclick = null; }

  function renderMeta() {
    var b = state.buffer, f = state.file;
    if (!b) { el.fileMeta.hidden = true; return; }
    el.fileMeta.hidden = false;
    el.fileMeta.innerHTML =
      cell('文件', f.name) +
      cell('时长', b.duration.toFixed(2) + ' s') +
      cell('采样率', b.sampleRate + ' Hz') +
      cell('声道', b.numberOfChannels === 1 ? '单声道' : b.numberOfChannels + ' 声道') +
      cell('体积', VA.decode.formatBytes(f.size)) +
      cell('解码后约占内存', VA.decode.formatBytes(VA.decode.estimateMemoryBytes(b)));
  }
  // 顺序是「值在前、标签在后」，不是笔误：styles.css 里 .file-meta b{display:block}，
  // <b> 包值并独占一行，渲染成"大号数值 / 下方小标签"的统计卡。
  // 因此 textContent 是 "4.00 s时长" 而不是 "时长 4.00 s"，验收脚本必须按这个顺序断言。
  function cell(k, v) { return '<div><b>' + esc(v) + '</b>' + esc(k) + '</div>'; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // 卸载当前素材：断引用交 GC（AudioBuffer 没有手动释放 API）
  function reset() {
    // 只 stop() 不够：player 是单例，它自己还攥着上一份 AudioBuffer。
    // 于是"卸载"之后 state.buffer 已是 null、界面说 empty，play() 却仍能放出旧素材
    // 的整段声音（Task 8 Step 5e 钉这条）。load(null) 内部也会 stop()，但这里仍显式停一次：
    // 不该让读代码的人靠"顺带"来确认旧声源已经断了。
    if (player) { player.stop(); player.load(null); }
    if (controller) { controller.destroy(); controller = null; }
    state.buffer = null;
    state.file = null;
    // 淡变默认 0：剪完直接导出是主路径，渐变是显式动作而不是赠品（用户 2026-10-01 要求）。
    // 三个参数控件的回填走 reset() 末尾的 syncParamInputs()，所以这里的 0 会真的显示成 0。
    state.recipe = { selection: { start: 0, end: 0 }, gain: 1, fadeIn: 0, fadeOut: 0 };
    state.zoom = { pps: 80, viewStart: 0 };
    // recipe 一换，三个参数控件与增益读数必须跟着换。放在 reset() 而不是 finishLoad()：
    // 到达 loaded 只有 finishLoad 一条路，而"换掉旧 recipe 却不进 finishLoad"的路有两条
    // ——解码失败的 catch、以及时长闸门取消。复审实测过：只在 finishLoad 调用时，
    // 载入坏文件后滑条停在 ×0.50 而 recipe.gain 已经是 1（面板虽被隐藏，但下一份素材的
    // 参数起点是脏的）。
    syncParamInputs();
  }

  function loadFile(file) {
    hideMessage();
    closeGate();
    if (!VA.decode.needSizeConfirm(file)) return actuallyLoad(file);
    // 闸门分支也必须返回 Promise：调用方写的是 loadFile(f).catch(...)，
    // 分支之间返回类型不一致（一个 Promise、一个 undefined）会让同一句测试代码 TypeError。
    return new Promise(function (resolve) {
      showGate('文件较大（' + VA.decode.formatBytes(file.size) + '），可能占用数百 MB 内存。',
        function () { resolve(actuallyLoad(file)); },
        // 取消＝当这次拖放没发生过。若之前已装载成功，素材还在，就回 loaded，
        // 不能谎称 empty（那会让面板隐藏、但 state.buffer 仍非空，状态机说谎）。
        function () { setState(state.buffer ? 'loaded' : 'empty'); resolve(); });
    });
  }

  function actuallyLoad(file) {
    var seq = ++loadSeq;
    reset();
    state.file = file;
    setState('decoding');
    return VA.decode.run(file).then(function (buffer) {
      if (seq !== loadSeq) return undefined;   // 已被更新的载入取代，不动 UI
      state.buffer = buffer;
      if (VA.decode.needDurationConfirm(buffer)) {
        showGate('该素材超过 60 分钟，解码后约占 ' +
          VA.decode.formatBytes(VA.decode.estimateMemoryBytes(buffer)) +
          ' 内存，导出长选段可能失败。',
          function () { /* 保留：继续装载 */ finishLoad(buffer); },
          function () { reset(); setState('empty'); renderMeta(); });
        return;   // 闸门挂起期间 Promise 先行兑现；Task 7 的验收用例走不到这条路径
      }
      finishLoad(buffer);
    }).catch(function (err) {
      // 只处理"当前这次载入"的失败：过期载入的失败既不能覆盖新文件的状态，
      // 也不该重新抛出（抛出会变成 unhandled rejection，把测试日志搅脏）。
      if (seq !== loadSeq) return undefined;
      setState('empty');
      renderMeta();
      showMessage(err.message || VA.decode.MESSAGES['audio-decode']);
      throw err;
    });
  }

  function finishLoad(buffer) {
    setState('loaded');
    renderMeta();
    state.recipe.selection = { start: 0, end: buffer.duration };
    el.selEnd.value = buffer.duration.toFixed(2);
    el.selEnd.max = buffer.duration;
    el.selStart.max = buffer.duration;
    controller = VA.waveform.mount(el.canvas, buffer, {
      recipe: state.recipe,
      onChange: onWaveSelection,
      onViewport: function (pps, viewStart) {
        state.zoom.pps = pps;
        state.zoom.viewStart = viewStart;
      }
    });
    player = VA.player.get();
    player.load(buffer);
    player.setOnTick(function (elapsed) {
      if (controller) controller.setPlayhead(state.recipe.selection.start + elapsed);
    });
    player.setOnEnd(function () {
      if (controller) controller.setPlayhead(-1);
      el.btnPlay.disabled = false;
    });
    // 不给 window.VA.app 另挂 _controller：对外钩子是返回对象里的 __controller getter，
    // 再写一个下划线同名属性等于两个来源，reset() 只清其中一个就会读到脏值。
    syncSelectionUI();
    // 参数控件的回填不在这里：reset() 已经做过，而 reset() 是所有换素材路径的必经点。
    el.btnExport.disabled = false;
    el.btnPlay.disabled = false;
    el.btnStop.disabled = false;
  }

  function onWaveSelection(sel) {
    state.recipe.selection = sel;
    syncSelectionUI();
  }

  function syncSelectionUI() {
    var r = VA.edit.clampRecipe(state.recipe, state.buffer ? state.buffer.duration : 0);
    state.recipe.selection = r.selection;
    el.selStart.value = r.selection.start.toFixed(2);
    el.selEnd.value = r.selection.end.toFixed(2);
    updateTimeReadout();
  }

  function updateTimeReadout() {
    var s = state.recipe.selection;
    el.timeReadout.textContent = (s.end - s.start).toFixed(2) + ' s 选段 / 共 ' +
      (state.buffer ? state.buffer.duration.toFixed(2) : '0.00') + ' s';
  }

  function syncParamInputs() {
    el.gainSlider.value = state.recipe.gain;
    el.fadeIn.value = state.recipe.fadeIn;
    el.fadeOut.value = state.recipe.fadeOut;
    updateGainReadout();
  }

  function bindNumberInput(input, apply) {
    input.addEventListener('change', function () {
      var v = parseFloat(input.value);
      if (!isFinite(v)) v = 0;
      apply(v);
      syncSelectionUI();
      if (controller) controller.setSelection(state.recipe.selection);
    });
  }

  function init() {
    el = {
      canvas: q('waveform'),
      fileInput: q('file-input'),
      dropZone: q('drop-zone'),
      fileMeta: q('file-meta'),
      gate: q('gate-bar'),
      gateText: q('gate-text'),
      gateYes: q('gate-yes'),
      gateNo: q('gate-no'),
      banner: q('banner'),
      bannerText: q('banner-text'),
      bannerClose: q('banner-close'),
      // panel-wave / panel-params 不进 el：setState 用 q() 就地取，两处各存一份引用会走偏
      selStart: q('sel-start'),
      selEnd: q('sel-end'),
      gainSlider: q('gain-slider'),
      gainReadout: q('gain-readout'),
      fadeIn: q('fade-in'),
      fadeOut: q('fade-out'),
      btnExport: q('btn-export'),
      btnPlay: q('btn-play'),
      btnStop: q('btn-stop'),
      timeReadout: q('time-readout'),
      exportNote: q('export-note'),
      zoomSelect: q('zoom-select')
    };

    el.fileInput.addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) loadFile(f);
    });

    ['dragenter', 'dragover'].forEach(function (t) {
      el.dropZone.addEventListener(t, function (ev) {
        ev.preventDefault();
        el.dropZone.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      el.dropZone.addEventListener(t, function (ev) {
        ev.preventDefault();
        el.dropZone.classList.remove('is-over');
      });
    });
    el.dropZone.addEventListener('drop', function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    el.bannerClose.addEventListener('click', hideMessage);

    bindNumberInput(el.selStart, function (v) { state.recipe.selection.start = v; });
    bindNumberInput(el.selEnd, function (v) { state.recipe.selection.end = v; });
    bindNumberInput(el.fadeIn, function (v) { state.recipe.fadeIn = v; });
    bindNumberInput(el.fadeOut, function (v) { state.recipe.fadeOut = v; });

    el.gainSlider.addEventListener('input', function () {
      state.recipe.gain = parseFloat(el.gainSlider.value);
      updateGainReadout();
    });
    updateGainReadout();

    el.btnPlay.addEventListener('click', function () {
      // 只有真播起来了才禁用按钮：卸载之后（`reset()` 把 player 的 buffer 也置了 null）
      // play() 返回 false，此时若照常禁用，onended 永远不会触发，按钮就从此死掉。
      // "选段长度为 0"走不到这里——clampRecipe 会把空段退回整段，见 Task 7 Step 8d。
      if (VA.player.get().play(state.recipe)) el.btnPlay.disabled = true;
    });
    el.btnStop.addEventListener('click', function () {
      VA.player.get().stop();
      if (controller) controller.setPlayhead(-1);
      el.btnPlay.disabled = false;
    });
    el.btnExport.addEventListener('click', function () { exportWav().catch(function () {}); });

    el.zoomSelect.addEventListener('change', function () {
      if (!controller) return;
      if (el.zoomSelect.value === 'fit') controller.fitWindow();
      else controller.setZoom(parseFloat(el.zoomSelect.value), controller.getViewStart());
    });

    setState('empty');
  }

  function updateGainReadout() {
    var g = state.recipe.gain;
    var db = g > 0 ? 20 * Math.log10(g) : -Infinity;
    el.gainReadout.textContent = '×' + g.toFixed(2) + ' · ' +
      (isFinite(db) ? (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB' : '-∞ dB');
  }

  function baseName(file) {
    var n = file.name || 'audio';
    return n.replace(/\.[^.]+$/, '').slice(0, 60) || 'audio';
  }

  function exportWav() {
    if (!state.buffer) return Promise.reject(new Error('尚未载入素材'));
    setState('exporting');
    el.btnExport.disabled = true;
    el.exportNote.textContent = '正在渲染…';

    // 让出一帧，使"正在渲染"能绘制出来
    return new Promise(function (res) { setTimeout(res, 0); }).then(function () {
      var chans = [];
      for (var c = 0; c < state.buffer.numberOfChannels; c++) chans.push(state.buffer.getChannelData(c));
      var rendered = VA.edit.render(chans, state.buffer.sampleRate, state.recipe);
      var blob = VA.wav.encode(rendered.channels, rendered.sampleRate);
      var name = baseName(state.file) + '_' + rendered.recipe.selection.start.toFixed(1) +
                 '_' + rendered.recipe.selection.end.toFixed(1) + '.wav';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

      el.exportNote.textContent = name + ' · ' + VA.decode.formatBytes(blob.size);
      setState('loaded');
      el.btnExport.disabled = false;
      return { fileName: name, bytes: blob.size, frames: rendered.frames };
    }).catch(function (err) {
      setState('loaded');
      el.btnExport.disabled = false;
      el.exportNote.textContent = '';
      if (err && (err.name === 'RangeError' || /memory|allocation/i.test(err.message || ''))) {
        showMessage('选段过长导致内存不足，请缩短选段或分批导出。');
      } else {
        showMessage('导出失败：' + (err.message || err));
      }
      throw err;
    });
  }

  return {
    init: init,
    loadFile: loadFile,
    showMessage: showMessage,
    hideMessage: hideMessage,
    updateGainReadout: updateGainReadout,
    exportWav: exportWav,
    __state: state,
    get __controller() { return controller; }
  };
})();

if (typeof module === 'object' && module.exports) module.exports = VA.app;
