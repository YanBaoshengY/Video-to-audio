globalThis.VA = globalThis.VA || {};
VA.player = (function () {
  var singleton = null;

  function create(ctx) {
    var buffer = null;
    var source = null;
    var gainNode = null;
    var startedAt = 0;      // ctx.currentTime 上的播放起点
    var selStart = 0;
    var dur = 0;
    var raf = 0;
    var onEnd = null, onTick = null;

    function load(buf) { buffer = buf; stop(); }

    function stop() {
      if (source) {
        source.onended = null;
        try { source.stop(); } catch (e) {}
        source.disconnect();
        source = null;
      }
      if (gainNode) { gainNode.disconnect(); gainNode = null; }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    function isPlaying() { return !!source; }

    // 试听不重新渲染：源 buffer 上指定 offset/duration，淡入淡出用实时 GainNode 斜坡
    function play(recipe) {
      stop();
      if (!buffer) return false;
      var r = VA.edit.clampRecipe(recipe, buffer.duration);
      selStart = r.selection.start;
      dur = r.selection.end - r.selection.start;
      if (dur <= 0) return false;

      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();

      source = ctx.createBufferSource();
      source.buffer = buffer;
      gainNode = ctx.createGain();
      var g = Math.max(0, r.gain);
      var t = ctx.currentTime + 0.02;

      if (r.fadeIn > 0) {
        gainNode.gain.setValueAtTime(0.0001, t);
        gainNode.gain.linearRampToValueAtTime(g, t + r.fadeIn);
      } else {
        gainNode.gain.setValueAtTime(g, t);
      }
      if (r.fadeOut > 0) {
        var fadeOutStart = Math.max(t + (r.fadeIn > 0 ? r.fadeIn : 0), t + dur - r.fadeOut);
        gainNode.gain.setValueAtTime(g, fadeOutStart);
        gainNode.gain.linearRampToValueAtTime(0.0001, t + dur);
      }

      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      source.onended = function () {
        stop();
        if (onEnd) onEnd();
      };
      startedAt = t;
      source.start(t, selStart, dur);

      var tick = function () {
        if (!source) return;
        var elapsed = ctx.currentTime - startedAt;
        if (elapsed < 0) elapsed = 0;
        if (onTick) onTick(Math.min(elapsed, dur));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return true;
    }

    return { load: load, play: play, stop: stop, isPlaying: isPlaying,
             setOnEnd: function (fn) { onEnd = fn; },
             setOnTick: function (fn) { onTick = fn; } };
  }

  function get() {
    if (!singleton) singleton = create(VA.decode.context());
    return singleton;
  }

  return { create: create, get: get };
})();
